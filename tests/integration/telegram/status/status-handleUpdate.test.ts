import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Telegraf, Telegram } from 'telegraf';
import { createBot } from '@/integrations/telegram/bot';
import { helpCommand } from '@/integrations/telegram/commands/help.command';
import { clientCommand } from '@/integrations/telegram/commands/client.command';
import { statusCommand, summaryCommand, downCommand } from '@/integrations/telegram/commands/status.command';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { setPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { resetConfigForTesting } from '@/config/env';
import { customerRepository } from '@/modules/customers/customer.repository';
import type { InventorySnapshot, PrtgInventoryCache } from '@/integrations/prtg/prtg.inventory.cache';

const adminId = '111111111';
const nonAdminId = '333333333';
const globalGroupId = '-1001234567890';
const globalGroupIdNum = -1001234567890;
const ordinaryGroupId = '-1009876543210';
const ordinaryGroupIdNum = -1009876543210;

function makeSnapshot(
  sensors: Array<{ objectId: number; sensorType: string; statusRaw: number; lastValue?: string }>,
): InventorySnapshot {
  return {
    sensors: sensors.map(s => ({
      objectId: s.objectId,
      deviceName: 'Device-A',
      sensorName: 'Ping',
      sensorType: s.sensorType,
      statusRaw: s.statusRaw,
      statusDisplay: `Status ${s.statusRaw}`,
      statusMessage: null,
      lastValue: s.lastValue ?? null,
      lastUp: null,
      lastDown: null,
    })),
    devices: [],
    generation: 1,
    fetchedAt: new Date().toISOString(),
  } as InventorySnapshot;
}

function makeCache(snap: InventorySnapshot | null, staleSnap: InventorySnapshot | null = null): PrtgInventoryCache {
  return {
    getFresh: () => snap,
    getStale: () => staleSnap,
    isFresh: () => snap !== null,
    isStale: () => staleSnap !== null,
    isExpired: () => snap === null && staleSnap === null,
    hasAnySnapshot: () => snap !== null || staleSnap !== null,
  } as PrtgInventoryCache;
}

let originalCallApi: typeof Telegram.prototype.callApi;
let sentMessages: Array<{ method: string; payload: any }>;

function makeUpdate(text: string, userId: string, chatId: string, chatType: string) {
  const fromId = parseInt(userId.replace('-', ''));
  const chatIdNum = parseInt(chatId.replace('-', ''));
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1,
      from: { id: fromId, is_bot: false, first_name: 'Test', last_name: 'User', username: 'testuser' },
      chat: { id: chatIdNum, type: chatType, first_name: 'Test Chat' },
      date: Math.floor(Date.now() / 1000),
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
    },
  };
}

describe('Bot handleUpdate: V5 status commands integration', () => {
  let bot: ReturnType<typeof createBot>;
  let c1Id: number;

  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', `${adminId}`);
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', globalGroupId);
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
    pendingMappingStore.cleanup();

    customerRepository.bulkCreate([
      { clientId: 'client1', name: 'Customer One', monitorType: 'prtg', pingHost: null, enabled: true },
      { clientId: 'client2', name: 'Customer Two', monitorType: 'prtg', pingHost: null, enabled: true },
    ]);

    const c1 = customerService.getByClientId('client1');
    if (!c1) throw new Error('Customer not found');
    c1Id = c1.id;

    mappingRepository.create({
      customerId: c1.id,
      prtgObjectId: 1001,
      prtgDeviceName: 'Device-A',
      prtgSensorName: 'Ping',
      mappingMethod: 'manual',
      confidence: 0.95,
      verified: true,
      mappedByTelegramId: adminId,
    });

    const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 3 }]);
    setPrtgInventoryCache(makeCache(snap, null));

    vi.restoreAllMocks();

    vi.spyOn(accessService, 'isAdmin').mockImplementation((userId: string) => userId === adminId);
    vi.spyOn(accessService, 'isPrivateChat').mockImplementation((chatType: string) => chatType === 'private');
    vi.spyOn(accessService, 'isGroupChat').mockImplementation((chatType: string) => chatType === 'group' || chatType === 'supergroup');
    vi.spyOn(accessService, 'isGlobalGroup').mockImplementation((chatId: string) => chatId === globalGroupId);
    vi.spyOn(accessService, 'isGroupRegistered').mockReturnValue(false);
    vi.spyOn(accessService, 'getCustomerAccessScope').mockImplementation((ctx: any) => {
      if (accessService.isPrivateChat(ctx.chatType)) {
        if (accessService.isAdmin(ctx.userId)) return { kind: 'all' };
        return { kind: 'none' };
      }
      if (accessService.isGlobalGroup(ctx.chatId)) return { kind: 'all' };
      if (ctx.chatId === ordinaryGroupId) {
        return { kind: 'assigned', customerIds: [c1Id] };
      }
      return { kind: 'none' };
    });
    vi.spyOn(accessService, 'canViewCustomer').mockImplementation((ctx: any, customerId: number) => {
      const scope = accessService.getCustomerAccessScope(ctx);
      if (scope.kind === 'all') return true;
      if (scope.kind === 'none') return false;
      return scope.customerIds.includes(customerId);
    });
    vi.spyOn(accessService, 'canManageMappings').mockImplementation((ctx: any) => {
      return accessService.isAdmin(ctx.userId) && (accessService.isPrivateChat(ctx.chatType) || accessService.isGlobalGroup(ctx.chatId));
    });

    originalCallApi = Telegram.prototype.callApi;
    sentMessages = [];
    Telegram.prototype.callApi = async (method: string, payload: any) => {
      sentMessages.push({ method, payload });
      if (method === 'getMe') {
        return { id: 999999999, first_name: 'TestBot', is_bot: true, username: 'test_bot' };
      }
      if (method === 'sendMessage') {
        return { message_id: 123, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id }, text: payload.text };
      }
      return {};
    };

    bot = createBot();
    bot.command('help', helpCommand);
    bot.command('client', clientCommand);
    bot.command('status', statusCommand);
    bot.command('summary', summaryCommand);
    bot.command('down', downCommand);
  });

  afterEach(() => {
    if (originalCallApi) {
      Telegram.prototype.callApi = originalCallApi;
    }
    vi.unstubAllEnvs();
  });

  it('/status client1 via handleUpdate returns status card', async () => {
    await bot.handleUpdate(makeUpdate('/status client1', adminId, '999999', 'private'));
    const sendMessage = sentMessages.find(m => m.method === 'sendMessage');
    expect(sendMessage).toBeDefined();
    expect(sendMessage!.payload.text).toContain('client1');
    expect(sendMessage!.payload.text).toContain('🟢 UP');
  });

  it('/summary via handleUpdate returns summary', async () => {
    await bot.handleUpdate(makeUpdate('/summary', adminId, '999999', 'private'));
    const sendMessage = sentMessages.find(m => m.method === 'sendMessage');
    expect(sendMessage).toBeDefined();
    expect(sendMessage!.payload.text).toContain('Total Customers: 2');
  });

  it('/down via handleUpdate returns DOWN CUSTOMERS', async () => {
    await bot.handleUpdate(makeUpdate('/down', adminId, '999999', 'private'));
    const sendMessage = sentMessages.find(m => m.method === 'sendMessage');
    expect(sendMessage).toBeDefined();
    expect(sendMessage!.payload.text).toContain('DOWN CUSTOMERS');
  });

  it('/client client1 via handleUpdate includes status', async () => {
    await bot.handleUpdate(makeUpdate('/client client1', adminId, '999999', 'private'));
    const sendMessage = sentMessages.find(m => m.method === 'sendMessage');
    expect(sendMessage).toBeDefined();
    expect(sendMessage!.payload.text).toContain('🟢 UP');
  });

  it('/help via handleUpdate includes status commands for admin', async () => {
    await bot.handleUpdate(makeUpdate('/help', adminId, '999999', 'private'));
    const sendMessage = sentMessages.find(m => m.method === 'sendMessage');
    expect(sendMessage).toBeDefined();
    const msg = sendMessage!.payload.text;
    expect(msg).toContain('/status');
    expect(msg).toContain('/summary');
    expect(msg).toContain('/down');
  });

  it('non-admin /down denied via handleUpdate', async () => {
    await bot.handleUpdate(makeUpdate('/down', nonAdminId, '999999', 'private'));
    const sendMessage = sentMessages.find(m => m.method === 'sendMessage');
    expect(sendMessage).toBeDefined();
    expect(sendMessage!.payload.text).toMatch(/akses ditolak|Access denied|not authorized/i);
  });

  it('/down 999 rejected with out-of-range via handleUpdate', async () => {
    const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
    setPrtgInventoryCache(makeCache(snap, null));

    await bot.handleUpdate(makeUpdate('/down 999', adminId, '999999', 'private'));
    const sendMessage = sentMessages.find(m => m.method === 'sendMessage');
    expect(sendMessage).toBeDefined();
    expect(sendMessage!.payload.text).toMatch(/access denied|out of range/i);
    expect(sendMessage!.payload.text).not.toContain('Page 999/1');
  });
});
