import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { groupClientsCommand } from '@/integrations/telegram/commands/group-clients.command';
import { accessService } from '@/modules/groups/access.service';
import { groupService } from '@/modules/groups/group.service';
import { customerService } from '@/modules/customers/customer.service';
import { groupRepository } from '@/modules/groups/group.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/group_clients command', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-gc-'));
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
    fromId: string;
  }) {
    const reply = vi.fn();
    return {
      userId: overrides.userId,
      chatId: overrides.chatId,
      chatType: overrides.chatType,
      from: { id: BigInt(overrides.fromId || "123456789") },
      reply,
    } as any;
  }

  describe('Registered ordinary', () => {
    it('can_view=1, receive_alerts=0', async () => {
      const customer = customerService.create({ clientId: 'GC-101', name: 'Visible No Alerts', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111112001', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111112001', customerId: customer.id, canView: true, receiveAlerts: false });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112001', chatType: 'group', fromId: '123456789' });
      await groupClientsCommand(ctx);
      
      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain('👁 Visible');
      expect(replyText).toContain('🔕 Alerts OFF');
    });

    it('can_view=1, receive_alerts=1', async () => {
      const customer = customerService.create({ clientId: 'GC-102', name: 'Visible With Alerts', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111112002', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111112002', customerId: customer.id, canView: true, receiveAlerts: true });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112002', chatType: 'group', fromId: '123456789' });
      await groupClientsCommand(ctx);
      
      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain('👁 Visible');
      expect(replyText).toContain('🔔 Alerts ON');
    });

    it('can_view=0, receive_alerts=1 is not shown in list', async () => {
      const customer = customerService.create({ clientId: 'GC-103', name: 'Hidden With Alerts', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111112003', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111112003', customerId: customer.id, canView: false, receiveAlerts: true });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112003', chatType: 'group', fromId: '123456789' });
      await groupClientsCommand(ctx);
      
      const replyText = ctx.reply.mock.calls[0][0];
      // Alerts-only customer should not appear in list
      expect(replyText).not.toContain('GC-103');
      expect(replyText).not.toContain('Hidden With Alerts');
    });

    it('UI shows only visible customers (can_view=1)', async () => {
      const c1 = customerService.create({ clientId: 'GC-104', name: 'V+N', monitorType: 'prtg', pingHost: null, enabled: true });
      const c2 = customerService.create({ clientId: 'GC-105', name: 'H+A', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111112004', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111112004', customerId: c1.id, canView: true, receiveAlerts: false });
      groupRepository.assignCustomer({ groupChatId: '-100111112004', customerId: c2.id, canView: false, receiveAlerts: true });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112004', chatType: 'group', fromId: '123456789' });
      await groupClientsCommand(ctx);
      
      const replyText = ctx.reply.mock.calls[0][0];
      // Only c1 (canView=true) should appear
      expect(replyText).toContain('👁 Visible');
      expect(replyText).toContain('🔕 Alerts OFF');
      expect(replyText).toContain('GC-104');
      // c2 (canView=false) should not appear
      expect(replyText).not.toContain('GC-105');
      expect(replyText).not.toContain('🚫 Hidden');
    });

    it('no raw 0/1', async () => {
      const customer = customerService.create({ clientId: 'GC-106', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111112006', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111112006', customerId: customer.id, canView: true, receiveAlerts: true });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112006', chatType: 'group', fromId: '123456789' });
      await groupClientsCommand(ctx);
      
      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).not.toContain(' 1 ');
      expect(replyText).not.toContain(' 0 ');
      expect(replyText).not.toContain('true');
      expect(replyText).not.toContain('false');
    });
  });

  describe('Global', () => {
    it('all customers shown without can_view rows', async () => {
      customerService.create({ clientId: 'GC-107', name: 'Global 1', monitorType: 'prtg', pingHost: null, enabled: true });
      customerService.create({ clientId: 'GC-108', name: 'Global 2', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', fromId: '123456789' });
      await groupClientsCommand(ctx);
      
      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain('GC-107');
      expect(replyText).toContain('GC-108');
    });

    it('explicit alert state correct', async () => {
      const customer1 = customerService.create({ clientId: 'GC-109', name: 'Alert On', monitorType: 'prtg', pingHost: null, enabled: true });
      const customer2 = customerService.create({ clientId: 'GC-110', name: 'Alert Off', monitorType: 'prtg', pingHost: null, enabled: true });
      
      // For Global Group, add alert subscriptions directly
      const { groupRepository } = await import('@/modules/groups/group.repository');
      groupRepository.setAlertSubscription({ groupChatId: '-1001234567890', customerId: customer1.id, receiveAlerts: true });
      groupRepository.setAlertSubscription({ groupChatId: '-1001234567890', customerId: customer2.id, receiveAlerts: false });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', fromId: '123456789' });
      await groupClientsCommand(ctx);
      
      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain('🔔 Alerts ON');
      expect(replyText).toContain('🔕 Alerts OFF');
    });

    it('alert OFF does not hide customer', async () => {
      customerService.create({ clientId: 'GC-111', name: 'No Alert', monitorType: 'prtg', pingHost: null, enabled: true });
      
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', fromId: '123456789' });
      await groupClientsCommand(ctx);
      
      const replyText = ctx.reply.mock.calls[0][0];
      expect(replyText).toContain('GC-111');
    });

    it('rendering creates no visibility rows', async () => {
      customerService.create({ clientId: 'GC-112', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      
      const beforeCount = groupRepository.getDb().prepare('SELECT COUNT(*) as c FROM group_customer_access WHERE group_chat_id = ?').get('-1001234567890') as { c: number };
      
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', fromId: '123456789' });
      await groupClientsCommand(ctx);
      
      const afterCount = groupRepository.getDb().prepare('SELECT COUNT(*) as c FROM group_customer_access WHERE group_chat_id = ?').get('-1001234567890') as { c: number };
      expect(afterCount.c).toBe(beforeCount.c);
    });
  });

  describe('Unregistered', () => {
    it('denied', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: '-100999999999', chatType: 'group', fromId: '999999999' });
      await groupClientsCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('not registered'));
    });
  });

  describe('Private', () => {
    it('wrong-context', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '123456789', chatType: 'private', fromId: '123456789' });
      await groupClientsCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('must be run inside a group'));
    });
  });

  it('no internal DB ids', async () => {
    customerService.create({ clientId: 'GC-113', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
    groupService.register('-100111112101', 'Test Group');
    
    const ctx = makeContext({ userId: '123456789', chatId: '-100111112101', chatType: 'group', fromId: '123456789' });
    await groupClientsCommand(ctx);
    
    const replyText = ctx.reply.mock.calls[0][0];
    expect(replyText).not.toMatch(/id.*\d+/i);
  });

  it('no raw null/undefined', async () => {
    const customer = customerService.create({ clientId: 'GC-114', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
    groupService.register('-100111112102', 'Test Group');
    groupRepository.assignCustomer({ groupChatId: '-100111112102', customerId: customer.id, canView: true, receiveAlerts: true });
    
    const ctx = makeContext({ userId: '123456789', chatId: '-100111112102', chatType: 'group', fromId: '123456789' });
    await groupClientsCommand(ctx);
    
    const replyText = ctx.reply.mock.calls[0][0];
    expect(replyText).not.toContain('null');
    expect(replyText).not.toContain('undefined');
  });
});