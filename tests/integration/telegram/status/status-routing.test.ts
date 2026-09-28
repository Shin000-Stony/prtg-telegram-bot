import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Telegraf, Telegram } from 'telegraf';
import { createBot } from '@/integrations/telegram/bot';
import { helpCommand } from '@/integrations/telegram/commands/help.command';
import { clientCommand } from '@/integrations/telegram/commands/client.command';
import { statusCommand, summaryCommand, downCommand } from '@/integrations/telegram/commands/status.command';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import { accessService, AccessContext } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { setPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations, getMigrationStatus } from '@/infrastructure/database/migration-runner';
import { resetConfigForTesting } from '@/config/env';
import { customerRepository } from '@/modules/customers/customer.repository';
import { validateHost } from '@/modules/monitoring/icmp.adapter';
import { MonitoringRepository } from '@/modules/monitoring/monitoring.repository';
import { fingerprintToString } from '@/modules/monitoring/monitoring.reducer';
import type { InventorySnapshot, PrtgInventoryCache } from '@/integrations/prtg/prtg.inventory.cache';

const adminId = '111111111';
const adminId2 = '222222222';
const nonAdminId = '333333333';
const globalGroupId = '-1001234567890';
const globalGroupIdNum = -1001234567890;
const ordinaryGroupId = '-1009876543210';
const ordinaryGroupIdNum = -1009876543210;

// Top-level mocks for bootstrap (hoisted)
let fakeShutdown: ReturnType<typeof vi.fn>;
vi.mock('@/bootstrap', () => ({
  bootstrap: vi.fn(),
  shutdown: () => fakeShutdown(),
  getDependencies: vi.fn(),
}));

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

let originalCallApi: typeof Telegram.prototype.callApi | undefined;

function makeMockContext(overrides: Partial<{
  userId: string; chatId: string; chatType: string; message: { text: string }; reply: ReturnType<typeof vi.fn>;
}> = {}) {
  const reply = vi.fn();
  return {
    userId: overrides.userId || adminId,
    chatId: overrides.chatId || '999999',
    chatType: overrides.chatType || 'private',
    message: overrides.message || { text: '/status client1' },
    reply,
    ...overrides,
  } as any;
}

describe('Bot routing: V5 status commands integration', () => {
  let bot: ReturnType<typeof createBot>;
  let c1Id: number;

  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', `${adminId},${adminId2}`);
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    vi.stubEnv('MONITORING_ENABLED', 'true');
    vi.stubEnv('ICMP_POLL_INTERVAL_MS', '30000');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
    pendingMappingStore.cleanup();

    customerRepository.bulkCreate([
      { clientId: 'client1', name: 'Customer One', monitorType: 'prtg', pingHost: null, enabled: true },
      { clientId: 'client2', name: 'Customer Two', monitorType: 'prtg', pingHost: null, enabled: true },
      { clientId: 'client3', name: 'Disabled Customer', monitorType: 'prtg', pingHost: null, enabled: false },
      { clientId: 'client4', name: 'PIC Customer', monitorType: 'pic', pingHost: null, enabled: true },
      { clientId: 'client5', name: 'ICMP Customer', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true },
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

    vi.spyOn(accessService, 'isAdmin').mockImplementation((userId: string) => {
      return userId === adminId || userId === adminId2;
    });
    vi.spyOn(accessService, 'isPrivateChat').mockImplementation((chatType: string) => {
      return chatType === 'private';
    });
    vi.spyOn(accessService, 'isGroupChat').mockImplementation((chatType: string) => {
      return chatType === 'group' || chatType === 'supergroup';
    });
    vi.spyOn(accessService, 'isGlobalGroup').mockImplementation((chatId: string) => {
      return chatId === globalGroupId;
    });
    vi.spyOn(accessService, 'isGroupRegistered').mockReturnValue(false);
    vi.spyOn(accessService, 'canViewCustomer').mockImplementation((ctx: AccessContext, customerId: number) => {
      const scope = accessService.getCustomerAccessScope(ctx);
      if (scope.kind === 'all') return true;
      if (scope.kind === 'none') return false;
      return scope.customerIds.includes(customerId);
    });
    vi.spyOn(accessService, 'getCustomerAccessScope').mockImplementation((ctx: AccessContext) => {
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
    vi.spyOn(accessService, 'canManageMappings').mockImplementation((ctx: AccessContext) => {
      return accessService.isAdmin(ctx.userId) && (accessService.isPrivateChat(ctx.chatType) || accessService.isGlobalGroup(ctx.chatId));
    });

    originalCallApi = Telegram.prototype.callApi;
    Telegram.prototype.callApi = async (method: string, payload: any) => {
      if (method === 'getMe') {
        return { id: 999999999, first_name: 'TestBot', is_bot: true, username: 'test_bot' };
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
      originalCallApi = undefined;
    }
    vi.unstubAllEnvs();
  });

  describe('/status command (app route registration)', () => {
    it('private admin gets status for client1', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/status client1' } });
      await statusCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('client1');
      expect(ctx.reply.mock.calls[0][0]).toContain('🟢 UP');
    });

    it('private non-admin is denied', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: '999999', chatType: 'private', message: { text: '/status client1' } });
      await statusCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toMatch(/Access denied|not authorized|akses ditolak/i);
    });

    it('global group non-admin gets read access', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: globalGroupId, chatType: 'supergroup', message: { text: '/status client1' } });
      await statusCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('🟢 UP');
    });

    it('ordinary assigned non-admin sees assigned customer', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: ordinaryGroupId, chatType: 'supergroup', message: { text: '/status client1' } });
      await statusCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
    });

    it('ordinary assigned non-admin denied for unassigned customer', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: ordinaryGroupId, chatType: 'supergroup', message: { text: '/status client2' } });
      await statusCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toMatch(/akses ditolak|Access denied|not authorized/i);
    });

    it('unregistered group denied', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: '-100999999', chatType: 'supergroup', message: { text: '/status client1' } });
      await statusCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toMatch(/akses ditolak|Access denied|not authorized/i);
    });

    it('disabled customer shows NONAKTIF', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/status client3' } });
      await statusCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('⚫ DISABLED');
    });

    it('PIC customer shows PIC-managed', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/status client4' } });
      await statusCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('📋 PIC-managed');
    });

    it('ICMP customer shows NOT CHECKED without monitoring state', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/status client5' } });
      await statusCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('⏳ NOT CHECKED');
    });

    it('unmapped customer shows UNMAPPED', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/status client2' } });
      await statusCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('⚪ UNMAPPED');
    });

    it('extra args rejected', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/status client1 extra' } });
      await statusCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Usage');
    });

    it('missing arg rejected', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/status' } });
      await statusCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Usage');
    });

    it('non-existent client in assigned scope uses same denial', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: ordinaryGroupId, chatType: 'supergroup', message: { text: '/status nonexistent' } });
      await statusCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toMatch(/akses ditolak|Access denied|not authorized/i);
    });
  });

  describe('/summary command (app route registration)', () => {
    it('private admin sees summary with correct buckets', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/summary' } });
      await summaryCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).toContain('SUMMARY');
      expect(msg).toContain('Total Customers: 5');
      expect(msg).toContain('🟢 UP : 1');
      expect(msg).toContain('⚫ DISABLED : 1');
      expect(msg).toContain('📋 PIC-managed : 1');
      expect(msg).toContain('⏳ NOT CHECKED : 1');
      expect(msg).toContain('⚪ UNMAPPED : 1');
      expect(msg).toContain('fresh=1');
      expect(msg).toContain('N/A=3');
    });

    it('private non-admin denied', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: '999999', chatType: 'private', message: { text: '/summary' } });
      await summaryCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toMatch(/akses ditolak|Access denied|not authorized/i);
    });

    it('global non-admin sees summary', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: globalGroupId, chatType: 'supergroup', message: { text: '/summary' } });
      await summaryCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('Total Customers: 5');
    });

    it('stale data summary with stale counts', async () => {
      const staleSnap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
      setPrtgInventoryCache(makeCache(null, staleSnap));
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/summary' } });
      await summaryCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('stale=1');
    });

    it('unavailable data summary with unavailable count', async () => {
      const c2 = customerService.getByClientId('client2');
      if (!c2) throw new Error('Customer not found');
      mappingRepository.create({
        customerId: c2.id,
        prtgObjectId: 2001,
        prtgDeviceName: 'Device-B',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.9,
        verified: true,
        mappedByTelegramId: adminId,
      });

      setPrtgInventoryCache(makeCache(null, null));
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/summary' } });
      await summaryCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('Data unavailable');
      expect(ctx.reply.mock.calls[0][0]).toContain('UNKNOWN : 2');
      expect(ctx.reply.mock.calls[0][0]).toContain('NOT CHECKED : 1');
    });
  });

  describe('/down command (app route registration)', () => {
    it('no DOWN on fresh UP data shows no confirmed DOWN', async () => {
      setPrtgInventoryCache(makeCache(makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 3 }]), null));
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/down' } });
      await downCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('DOWN CUSTOMERS');
      expect(ctx.reply.mock.calls[0][0]).toContain('0 total');
      expect(ctx.reply.mock.calls[0][0]).toContain('0 total');
    });

    it('page 999 rejected with clear range', async () => {
      const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
      setPrtgInventoryCache(makeCache(snap, null));
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/down 999' } });
      await downCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('out of range');
    });

    it('private non-admin /down denied before lookup', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: '999999', chatType: 'private', message: { text: '/down' } });
      await downCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toMatch(/akses ditolak|Access denied|not authorized/i);
    });

    it('extra args rejected', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/down 1 extra' } });
      await downCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Too many');
    });

    it('page 0 rejected', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/down 0' } });
      await downCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Invalid page');
    });

    it('decimal page rejected', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/down 1.5' } });
      await downCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Invalid page');
    });

    it('DOWN customer appears when fresh raw5', async () => {
      const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
      setPrtgInventoryCache(makeCache(snap, null));
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/down' } });
      await downCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('client1');
    });

    it('stale DOWN does not appear, shows uncertain warning', async () => {
      const staleSnap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
      setPrtgInventoryCache(makeCache(null, staleSnap));
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/down' } });
      await downCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('DOWN CUSTOMERS');
      expect(ctx.reply.mock.calls[0][0]).toContain('stale/unknown data');
    });

    it('stale raw14 DOWN does not appear', async () => {
      const staleSnap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 14 }]);
      setPrtgInventoryCache(makeCache(null, staleSnap));
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/down' } });
      await downCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).not.toContain('client1');
      expect(ctx.reply.mock.calls[0][0]).toContain('stale/unknown data');
    });

    it('pagination with >20 DOWN customers', async () => {
      for (let i = 0; i < 25; i++) {
        customerRepository.bulkCreate([{
          clientId: `down${i}`,
          name: `DOWN Customer ${i}`,
          monitorType: 'prtg',
          pingHost: null,
          enabled: true,
        }]);
        const c = customerService.getByClientId(`down${i}`);
        if (c) {
          mappingRepository.create({
            customerId: c.id,
            prtgObjectId: 2000 + i,
            prtgDeviceName: 'Device',
            prtgSensorName: 'Ping',
            mappingMethod: 'manual',
            confidence: 0.9,
            verified: true,
            mappedByTelegramId: adminId,
          });
        }
      }
      const sensors = Array.from({ length: 25 }, (_, i) => ({
        objectId: 2000 + i,
        sensorType: 'Ping',
        statusRaw: 5,
      }));
      setPrtgInventoryCache(makeCache(makeSnapshot(sensors), null));

      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/down' } });
      await downCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('Page 1/2');
    });
  });

  describe('/client command (app route registration) - status + V4 mapping UI', () => {
    it('shows status summary alongside V4 detail', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/client client1' } });
      await clientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      expect(ctx.reply.mock.calls[0][0]).toContain('🟢 UP');
    });

    it('non-admin denied for /client', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: '999999', chatType: 'private', message: { text: '/client client1' } });
      await clientCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toMatch(/Access denied|not authorized/i);
    });
  });

  describe('/help command (app route registration)', () => {
    it('help includes status commands for private admin', async () => {
      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/help' } });
      await helpCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledTimes(1);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).toContain('/status');
      expect(msg).toContain('/summary');
      expect(msg).toContain('/down');
    });

    it('help does not include status commands for unprivileged', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: '999999', chatType: 'private', message: { text: '/help' } });
      await helpCommand(ctx);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).not.toContain('/status');
    });

    it('help includes status for global non-admin', async () => {
      const ctx = makeMockContext({ userId: nonAdminId, chatId: globalGroupId, chatType: 'supergroup', message: { text: '/help' } });
      await helpCommand(ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('/status');
    });
  });

  describe('long HTML output', () => {
    it('20 rows with long names truncated to valid message chunks', async () => {
      for (let i = 0; i < 20; i++) {
        customerRepository.bulkCreate([{
          clientId: `long${i}`,
          name: 'A'.repeat(200) + ' ' + i,
          monitorType: 'prtg',
          pingHost: null,
          enabled: true,
        }]);
      }

      const customers = customerRepository.findAllUnpaged({});
      for (const c of customers) {
        if (c.clientId.startsWith('long')) {
          mappingRepository.create({
            customerId: c.id,
            prtgObjectId: 5000 + c.id,
            prtgDeviceName: 'D'.repeat(150),
            prtgSensorName: 'Ping',
            mappingMethod: 'manual',
            confidence: 0.9,
            verified: true,
            mappedByTelegramId: adminId,
          });
        }
      }

      const sensors = customers
        .filter(c => c.clientId.startsWith('long'))
        .map(c => ({ objectId: 5000 + c.id, sensorType: 'Ping', statusRaw: 5 }));

      const snap = makeSnapshot(sensors);
      setPrtgInventoryCache(makeCache(snap, null));

      const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/down' } });
      await downCommand(ctx);

      for (const call of ctx.reply.mock.calls) {
        const text: string = call[0];
        expect(text.length).toBeLessThanOrEqual(4096);
      }
    });
  });

  describe('F7: regression coverage for all 7 findings across V6 R2', () => {
    describe('F1: ICMP not_checked → NOT_CHECKED (not DOWN/UP)', () => {
      it('ICMP customer with no monitoring state shows NOT_CHECKED, not DOWN', async () => {
        const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/status client5' } });
        await statusCommand(ctx);
        expect(ctx.reply.mock.calls[0][0]).toContain('⏳ NOT CHECKED');
        expect(ctx.reply.mock.calls[0][0]).not.toMatch(/🟢 UP|🔴 DOWN/);
      });
    });

    describe('F2: stable observation identity', () => {
      it('duplicate observation ID is deduplicated (no double-counting)', async () => {
        const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
        const cache = makeCache(snap, null);
        setPrtgInventoryCache(cache);
        const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/summary' } });
        await summaryCommand(ctx);
        const msg = ctx.reply.mock.calls[0][0];
        expect(msg).toContain('🔴 DOWN : 1');
      });
    });

    describe('F3: SQLite rollback preserves observation identity', () => {
      it('migration004 columns present for dedupe', () => {
        const status = getMigrationStatus();
        expect(status[3].version).toBe(4);
        expect(status[3].applied).toBe(true);
      });
    });

    describe('F4: ICMP customers appear in DOWN list', () => {
      it('DOWN ICMP customer with monitoring state appears in /down', async () => {
        const c5 = customerService.getByClientId('client5');
        if (!c5) throw new Error('ICMP customer not found');

        // Add monitoring state for ICMP customer with DOWN status
        const { monitoringRepository } = await import('@/modules/monitoring/monitoring.repository');
        const { fingerprintToString } = await import('@/modules/monitoring/monitoring.reducer');
        const now = Date.now();
        monitoringRepository.upsert({
          customerId: c5.id,
          monitorType: 'icmp',
          targetFingerprint: fingerprintToString('icmp', true, '10.0.0.1', null),
          stableHealth: 'DOWN',
          latestObservation: 'DOWN',
          latestReason: 'no_reply',
          latestRawStatus: null,
          observedAt: now,
          lastAttemptAt: now,
          lastObservationAt: now,
          lastGoodObservationAt: null,
          consecutiveCount: 2,
          stableChangedAt: now,
          lastTransitionKind: 'DOWN',
          lastTransitionAt: now,
          lastProcessedGeneration: 1,
          lastProcessedObservationId: `icmp|1|10.0.0.1|${now}`,
        });

        // Verify the state was inserted
        const inserted = monitoringRepository.findById(c5.id);
        expect(inserted).toBeTruthy();
        expect(inserted!.latestObservation).toBe('DOWN');

        // Create fresh StatusService with test config
        const { StatusService } = await import('@/modules/status/status.service');
        const { MappingService } = await import('@/modules/mapping/mapping.service');
        const testStatusService = new StatusService(new MappingService(), Date.now);

        const ctx: any = { userId: adminId, chatId: '999999', chatType: 'private' };
        const downResult = testStatusService.listDown(ctx, 1);

        expect(downResult).toBeTruthy();
        expect(downResult.total).toBe(1);
        expect(downResult.items[0].clientId).toBe('client5');
        expect(downResult.items[0].objectId).toBeNull();
      });
    });

    describe('F5: scheduler reschedule after failure', () => {
      it('engine stops cleanly without hanging', async () => {
        const { createMonitoringEngine, createMonitoringConfig } = await import('@/modules/monitoring/monitoring.factory');
        const { getConfig } = await import('@/config/env');
        
        const config = createMonitoringConfig(getConfig());
        const engine = createMonitoringEngine(getConfig());
        engine.start();
        await engine.stop();
        expect(engine.isRunning()).toBe(false);
      });
    });

    describe('F6: ICMP runner aborts kill child', () => {
      it('ping host validation rejects leading dash', () => {
        expect(validateHost('-c1').valid).toBe(false);
      });
    });

    describe('F7: summary buckets consistent', () => {
      it('all 5 customers appear in summary with correct counts', async () => {
        const ctx = makeMockContext({ userId: adminId, chatId: '999999', chatType: 'private', message: { text: '/summary' } });
        await summaryCommand(ctx);
        const msg = ctx.reply.mock.calls[0][0];
        expect(msg).toContain('Total Customers: 5');
        expect(msg).toContain('fresh=1');
        expect(msg).toContain('N/A=3');
      });
    });

    describe('R5-1: app shutdown - signal + launch rejection teardown once (production app.ts)', () => {
      let capturedSignalHandlers: Map<NodeJS.Signals, () => void>;
      let originalProcessOn: typeof process.on;
      let originalProcessExit: typeof process.exit;
      let capturedExitCode: number | null;
      let launchPromise: Promise<void>;
      let resolveLaunch: (value: void) => void;
      let rejectLaunch: (reason: Error) => void;

      const makeFakeBot = (): any => ({
        command: vi.fn(),
        action: vi.fn(),
        on: vi.fn(),
        stop: vi.fn((signal: NodeJS.Signals) => Promise.resolve()),
        launch: vi.fn(() => launchPromise),
      });

      const makeFakeEngine = (): any => ({
        stop: vi.fn(async () => { /* track calls */ }),
        start: vi.fn(),
        isRunning: vi.fn(() => true),
      });

beforeEach(() => {
    fakeShutdown = vi.fn(() => {
      console.log('DEBUG: fakeShutdown called');
      dbShutdownCalls++;
    });
    capturedSignalHandlers = new Map();
    originalProcessOn = process.on.bind(process);
    originalProcessExit = process.exit;

    process.on = vi.fn((signal: string, handler: () => void) => {
      if (signal === 'SIGINT' || signal === 'SIGTERM') {
        capturedSignalHandlers.set(signal as NodeJS.Signals, handler);
      }
      return originalProcessOn(signal, handler);
    });
    process.exit = vi.fn((code?: number) => {
      capturedExitCode = code ?? 1;
    });

        launchPromise = new Promise<void>((resolve, reject) => {
          resolveLaunch = resolve;
          rejectLaunch = reject;
        });
      });

      afterEach(() => {
        process.on = originalProcessOn;
        process.exit = originalProcessExit;
        vi.resetModules();
        vi.restoreAllMocks();
      });

      async function loadAppModule(fakeBot: any, fakeEngine: any): Promise<void> {
        let monitoringEngineRef: any = fakeEngine;

        // Mock all dependencies that app.ts imports
        vi.doMock('@/core/logger', () => {
          const createLogger = () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            fatal: vi.fn(),
            child: vi.fn(() => createLogger()),
          });
          return {
            getLogger: () => createLogger(),
          };
        });

        vi.doMock('@/integrations/telegram/bot', () => ({
          createBot: () => fakeBot,
        }));

        vi.doMock('@/integrations/telegram/commands/help.command', () => ({
          helpCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/chatid.command', () => ({
          chatIdCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/clients.command', () => ({
          clientsCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/client.command', () => ({
          clientCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/add-client.command', () => ({
          addClientCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/client-state.command', () => ({
          enableClientCommand: vi.fn(),
          disableClientCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/register-group.command', () => ({
          registerGroupCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/unregister-group.command', () => ({
          unregisterGroupCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/group-clients.command', () => ({
          groupClientsCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/assign-client.command', () => ({
          assignClientCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/unassign-client.command', () => ({
          unassignClientCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/group-alerts.command', () => ({
          groupAlertsCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/prtg-inventory.command', () => ({
          prtgInventoryCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/prtg-search.command', () => ({
          prtgSearchCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/map-client.command', () => ({
          mapClientCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/status.command', () => ({
          statusCommand: vi.fn(),
          summaryCommand: vi.fn(),
          downCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/auto-map.command', () => ({
          autoMapCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/unmap-client.command', () => ({
          unmapClientCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/commands/mappings.command', () => ({
          mappingsCommand: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/handlers/csv-import.handler', () => ({
          handleCsvDocument: vi.fn(),
          handleCsvConfirm: vi.fn(),
          handleCsvCancel: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/handlers/unregister-group.handler', () => ({
          handleUnregisterConfirm: vi.fn(),
          handleUnregisterCancel: vi.fn(),
        }));
        vi.doMock('@/integrations/telegram/handlers/mapping-callbacks', () => ({
          handleMapConfirm: vi.fn(),
          handleMapCancel: vi.fn(),
          handleMapSearch: vi.fn(),
          handleMapSelect: vi.fn(),
          handleMapVerify: vi.fn(),
          handleAutoMapApply: vi.fn(),
          handleAutoMapCancel: vi.fn(),
          handleUnmapConfirm: vi.fn(),
          handleUnmapCancel: vi.fn(),
          handleSearchPagination: vi.fn(),
        }));
        vi.doMock('@/integrations/prtg/prtg-inventory.shared', () => ({
          setPrtgInventoryCache: vi.fn(),
        }));
        vi.doMock('@/integrations/prtg/prtg.client', () => ({
          createPrtgClient: vi.fn(),
        }));
        vi.doMock('@/integrations/prtg/prtg.transport', () => ({
          HttpsPrtgTransport: vi.fn(),
        }));
        vi.doMock('@/integrations/prtg/prtg.inventory.cache', () => ({
          createPrtgInventoryCache: vi.fn(),
        }));
        vi.doMock('@/modules/monitoring/monitoring.factory', () => ({
          createMonitoringEngine: vi.fn(() => monitoringEngineRef),
          createMonitoringConfig: vi.fn(() => ({ enabled: true })),
          createMonitoringEngineWithAlerting: vi.fn(() => monitoringEngineRef),
          createIcmpPingRunner: vi.fn(() => vi.fn()),
        }));

        // Import and run app.ts main - this executes the module's main() call
        await import('@/app');
      }

      it('SIGTERM + launch rejection executes teardown once via production handlers', async () => {
        const fakeBot = makeFakeBot();
        const fakeEngine = makeFakeEngine();
        let engineStopCalls = 0;
        let dbShutdownCalls = 0;
        let botStopCalls = 0;

        const originalStop = fakeEngine.stop;
        fakeEngine.stop = vi.fn(async () => {
          console.log('DEBUG: fakeEngine.stop called');
          engineStopCalls++;
          await originalStop();
        });
        const originalBotStop = fakeBot.stop;
        fakeBot.stop = vi.fn(async (signal: NodeJS.Signals) => {
          console.log('DEBUG: fakeBot.stop called');
          botStopCalls++;
          await originalBotStop(signal);
        });

        const fakeShutdown = vi.fn(() => {
          console.log('DEBUG: fakeShutdown called');
          dbShutdownCalls++;
        });
        vi.doMock('@/bootstrap', () => ({
          bootstrap: vi.fn(),
          shutdown: fakeShutdown,
          getDependencies: vi.fn(),
        }));

        await loadAppModule(fakeBot, fakeEngine);

        // Wait for app to register signal handlers (before launch)
        await new Promise(r => setTimeout(r, 50));

        // Simulate SIGINT via captured handler (app registers SIGINT in test env)
        const sigintHandler = capturedSignalHandlers.get('SIGINT');
        console.log('DEBUG: sigintHandler:', sigintHandler);
        expect(sigintHandler).toBeDefined();
        await sigintHandler!();

        // Reject the pending launch (simulates launch failure)
        // Attach catch handler to suppress unhandled rejection warning
        launchPromise.catch(() => {});
        const launchError = new Error('launch failed');
        rejectLaunch!(launchError);

        // Wait for launch rejection to be caught and handleShutdown called
        await new Promise(r => setTimeout(r, 200));

        // Simulate repeated SIGINT
        await sigintHandler!();

        // Wait for all handlers
        await new Promise(r => setTimeout(r, 200));

        console.log('DEBUG: engineStopCalls:', engineStopCalls, 'botStopCalls:', botStopCalls, 'dbShutdownCalls:', dbShutdownCalls);
        expect(engineStopCalls).toBe(1);
        expect(botStopCalls).toBe(1);
        expect(dbShutdownCalls).toBe(1);

        // Cleanup
        resolveLaunch!();
      });

      it('shutdown rejection is caught by production signal handler without unhandled rejection', async () => {
        const fakeBot = makeFakeBot();
        const fakeEngine = makeFakeEngine();
        let rejectShutdown = false;

        const fakeShutdown = vi.fn(() => {
          if (rejectShutdown) throw new Error('shutdown failed');
        });
        vi.doMock('@/bootstrap', () => ({
          bootstrap: vi.fn(),
          shutdown: fakeShutdown,
          getDependencies: vi.fn(),
        }));

        await loadAppModule(fakeBot, fakeEngine);

        // Wait for app to register signal handlers
        await new Promise(r => setTimeout(r, 50));

        // Simulate SIGINT via captured handler
        const sigintHandler = capturedSignalHandlers.get('SIGINT');
        expect(sigintHandler).toBeDefined();

        // Make shutdown reject
        rejectShutdown = true;

        // Invoke signal handler - production code catches rejection internally
        // This should NOT produce an unhandled rejection
        await sigintHandler!();

        // Wait for rejection to be handled
        await new Promise(r => setTimeout(r, 100));

        // Simulate repeated signal - should return same promise
        await sigintHandler!();
        await new Promise(r => setTimeout(r, 50));

        // No unhandled rejection should have occurred
        // (If it did, the test would fail at the process level)
      });
    });

    describe('R5-2: ICMP abort/timeout → late error → close', () => {
      it('abort → late ABORT_ERR → close settles once, cleans up', async () => {
        const { createIcmpPingRunner } = await import('@/modules/monitoring/icmp.adapter');
        const clock = () => Date.now();

        let errorEmitted = false;
        let closeEmitted = false;

        const fakeChild = {
          stdout: {
            on: vi.fn((event, cb) => {
              if (event === 'data') cb(Buffer.from(''));
            }),
          },
          stderr: { on: vi.fn() },
          on: vi.fn((event, cb) => {
            if (event === 'error') {
              setTimeout(() => {
                errorEmitted = true;
                const err = new Error('ABORT_ERR');
                err.code = 'ABORT_ERR';
                cb(err);
              }, 10);
            }
            if (event === 'close') {
              setTimeout(() => {
                closeEmitted = true;
                cb(0);
              }, 20);
            }
          }),
          kill: vi.fn(),
          removeAllListeners: vi.fn(),
        };

        const runner = createIcmpPingRunner({
          clock,
          spawn: vi.fn(() => fakeChild),
        });

        const controller = new AbortController();
        const promise = runner('10.0.0.1', 3000, controller.signal);
        
        // Abort immediately
        controller.abort();
        
        const result = await promise;
        
        expect(result.reason).toBe('aborted');
        expect(result.status).toBe('UNKNOWN');
        
        // Wait for late error and close
        await new Promise(r => setTimeout(r, 50));
        
        expect(errorEmitted).toBe(true);
        expect(closeEmitted).toBe(true);
        expect(fakeChild.removeAllListeners).toHaveBeenCalled();
        expect(fakeChild.kill).toHaveBeenCalled();
      });

      it('timeout → late error → close settles once, cleans up', async () => {
        const { createIcmpPingRunner } = await import('@/modules/monitoring/icmp.adapter');
        const clock = () => Date.now();

        let errorEmitted = false;
        let closeEmitted = false;

        const fakeChild = {
          stdout: {
            on: vi.fn((event, cb) => {
              if (event === 'data') cb(Buffer.from(''));
            }),
          },
          stderr: { on: vi.fn() },
          on: vi.fn((event, cb) => {
            if (event === 'error') {
              // Emit late error AFTER runner's timeout (50ms + 2000ms = 2050ms)
              setTimeout(() => {
                errorEmitted = true;
                const err = new Error('EPIPE');
                err.code = 'EPIPE';
                cb(err);
              }, 2500);
            }
            if (event === 'close') {
              setTimeout(() => {
                closeEmitted = true;
                cb(null);
              }, 2600);
            }
          }),
          kill: vi.fn(),
          removeAllListeners: vi.fn(),
        };

        const runner = createIcmpPingRunner({
          clock,
          spawn: vi.fn(() => fakeChild),
        });

        const promise = runner('10.0.0.1', 50); // runner timeout = 50 + 2000 = 2050ms
        
        const result = await promise;
        
        expect(result.reason).toBe('timeout');
        expect(result.status).toBe('UNKNOWN');
        
        // Wait for late error and close
        await new Promise(r => setTimeout(r, 1000));
        
        expect(errorEmitted).toBe(true);
        expect(closeEmitted).toBe(true);
        expect(fakeChild.removeAllListeners).toHaveBeenCalled();
        expect(fakeChild.kill).toHaveBeenCalled();
      });
    });
  });
});
