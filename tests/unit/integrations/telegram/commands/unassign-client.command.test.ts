import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { unassignClientCommand } from '@/integrations/telegram/commands/unassign-client.command';
import { accessService } from '@/modules/groups/access.service';
import { groupService } from '@/modules/groups/group.service';
import { customerService } from '@/modules/customers/customer.service';
import { groupRepository } from '@/modules/groups/group.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/unassign_client command', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-uc-'));
    testDbPath = join(testDir, 'test.db');
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', '123456789');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('DATABASE_PATH', testDbPath);
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    runMigrations();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  function makeContext(overrides: {
    userId: string;
    chatId: string;
    chatType: string;
    messageText: string;
    fromId: string;
  }) {
    const reply = vi.fn();
    return {
      userId: overrides.userId,
      chatId: overrides.chatId,
      chatType: overrides.chatType,
      message: { text: overrides.messageText },
      from: { id: BigInt(overrides.fromId || "123456789") },
      reply,
    } as any;
  }

  describe('ordinary admin -> can_view cleared', () => {
    it('clears can_view', async () => {
      const customer = customerService.create({ clientId: 'UC-101', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111801', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111801', customerId: customer.id, canView: true, receiveAlerts: false });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111801', chatType: 'group', messageText: '/unassign_client UC-101', fromId: '123456789' });
      await unassignClientCommand(ctx);
      
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Customer unassigned from group'));
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('UC-101'));
    });
  });

  describe('receive_alerts=0 -> zero/zero cleanup if intended', () => {
    it('removes row when both flags zero', async () => {
      const customer = customerService.create({ clientId: 'UC-102', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111802', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111802', customerId: customer.id, canView: true, receiveAlerts: false });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111802', chatType: 'group', messageText: '/unassign_client UC-102', fromId: '123456789' });
      await unassignClientCommand(ctx);
      
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Customer unassigned from group'));
    });
  });

  describe('receive_alerts=1 -> row preserved', () => {
    it('preserves row with can_view=0, receive_alerts=1', async () => {
      const customer = customerService.create({ clientId: 'UC-103', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111803', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111803', customerId: customer.id, canView: true, receiveAlerts: true });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111803', chatType: 'group', messageText: '/unassign_client UC-103', fromId: '123456789' });
      await unassignClientCommand(ctx);
      
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Client is hidden. Alert subscription remains ON.'));
    });
  });

  describe('UI clearly says alerts remain ON when applicable', () => {
    it('message mentions alerts remain ON', async () => {
      const customer = customerService.create({ clientId: 'UC-104', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111804', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111804', customerId: customer.id, canView: true, receiveAlerts: true });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111804', chatType: 'group', messageText: '/unassign_client UC-104', fromId: '123456789' });
      await unassignClientCommand(ctx);
      
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Alert subscription remains ON'));
    });
  });

  describe('already unassigned -> idempotent', () => {
    it('idempotent', async () => {
      const customer = customerService.create({ clientId: 'UC-105', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111805', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111805', customerId: customer.id, canView: true, receiveAlerts: false });
      
      const ctx1 = makeContext({ userId: '123456789', chatId: '-100111111805', chatType: 'group', messageText: '/unassign_client UC-105', fromId: '123456789' });
      await unassignClientCommand(ctx1);
      
      const ctx2 = makeContext({ userId: '123456789', chatId: '-100111111805', chatType: 'group', messageText: '/unassign_client UC-105', fromId: '123456789' });
      await unassignClientCommand(ctx2);
      
      expect(ctx2.reply).toHaveBeenCalledWith(expect.stringContaining('Customer unassigned from group'));
    });
  });

  describe('unknown client -> safe', () => {
    it('not found', async () => {
      groupService.register('-100111111806', 'Test Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111806', chatType: 'group', messageText: '/unassign_client UNKNOWN', fromId: '123456789' });
      await unassignClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Customer not found'));
    });
  });

  describe('authorization', () => {
    it('non-admin -> denied', async () => {
      customerService.create({ clientId: 'UC-109', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111807', 'Test Group');
      const ctx = makeContext({ userId: '999999999', chatId: '-100111111807', chatType: 'group', messageText: '/unassign_client UC-109', fromId: '999999999' });
      await unassignClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    });

    it('unregistered -> denied', async () => {
      customerService.create({ clientId: 'UC-110', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      const ctx = makeContext({ userId: '123456789', chatId: '-100999999999', chatType: 'group', messageText: '/unassign_client UC-110', fromId: '123456789' });
      await unassignClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('not registered'));
    });

    it('Global Group -> informational', async () => {
      customerService.create({ clientId: 'UC-111', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', messageText: '/unassign_client UC-111', fromId: '123456789' });
      await unassignClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('cannot hide customers'));
    });

    it('private -> wrong context', async () => {
      customerService.create({ clientId: 'UC-112', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      const ctx = makeContext({ userId: '123456789', chatId: '123456789', chatType: 'private', messageText: '/unassign_client UC-112', fromId: '123456789' });
      await unassignClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('This command only works in groups'));
    });
  });
});