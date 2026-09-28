import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { groupAlertsCommand } from '@/integrations/telegram/commands/group-alerts.command';
import { accessService } from '@/modules/groups/access.service';
import { groupService } from '@/modules/groups/group.service';
import { customerService } from '@/modules/customers/customer.service';
import { groupRepository } from '@/modules/groups/group.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/group_alerts command', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-ga-'));
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

  describe('Ordinary group', () => {
    describe('visible + on => receive_alerts=1', () => {
      it('enables alerts for visible customer', async () => {
        const customer = customerService.create({ clientId: 'GA-101', name: 'Visible Client', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.register('-100111111901', 'Test Group');
        groupRepository.assignCustomer({ groupChatId: '-100111111901', customerId: customer.id, canView: true, receiveAlerts: false });
        
        const ctx = makeContext({ userId: '123456789', chatId: '-100111111901', chatType: 'group', messageText: '/group_alerts GA-101 on', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Alert subscription enabled'));
      });
    });

    describe('visible + off => 0', () => {
      it('disables alerts for visible customer', async () => {
        const customer = customerService.create({ clientId: 'GA-102', name: 'Visible Client', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.register('-100111111902', 'Test Group');
        groupRepository.assignCustomer({ groupChatId: '-100111111902', customerId: customer.id, canView: true, receiveAlerts: true });
        
        const ctx = makeContext({ userId: '123456789', chatId: '-100111111902', chatType: 'group', messageText: '/group_alerts GA-102 off', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Alert subscription disabled'));
      });
    });

    describe('hidden + on => allowed (explicit subscription without visibility)', () => {
      it('allows enabling alerts for hidden customer', async () => {
        const customer = customerService.create({ clientId: 'GA-103', name: 'Hidden Client', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.register('-100111111903', 'Test Group');
        groupRepository.assignCustomer({ groupChatId: '-100111111903', customerId: customer.id, canView: false, receiveAlerts: false });
        
        const ctx = makeContext({ userId: '123456789', chatId: '-100111111903', chatType: 'group', messageText: '/group_alerts GA-103 on', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Alert subscription enabled'));
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Visibility: Hidden'));
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Alerts: ON'));
      });
    });

    describe('hidden stale + off => allowed', () => {
      it('allows disabling alerts for hidden customer with stale subscription', async () => {
        const customer = customerService.create({ clientId: 'GA-104', name: 'Hidden Client', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.register('-100111111904', 'Test Group');
        groupRepository.assignCustomer({ groupChatId: '-100111111904', customerId: customer.id, canView: false, receiveAlerts: true });
        
        const ctx = makeContext({ userId: '123456789', chatId: '-100111111904', chatType: 'group', messageText: '/group_alerts GA-104 off', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Alert subscription disabled'));
      });
    });

    describe('unknown client -> not found', () => {
      it('returns not found', async () => {
        groupService.register('-100111111905', 'Test Group');
        const ctx = makeContext({ userId: '123456789', chatId: '-100111111905', chatType: 'group', messageText: '/group_alerts UNKNOWN on', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Customer not found'));
      });
    });

    describe('invalid mode -> usage error', () => {
      it('returns error for invalid mode', async () => {
        groupService.register('-100111111906', 'Test Group');
        const ctx = makeContext({ userId: '123456789', chatId: '-100111111906', chatType: 'group', messageText: '/group_alerts GA-101 maybe', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Action must be "on" or "off"'));
      });
    });

    describe('non-admin -> denied', () => {
      it('denies non-admin', async () => {
        customerService.create({ clientId: 'GA-105', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.register('-100111111907', 'Test Group');
        const ctx = makeContext({ userId: '999999999', chatId: '-100111111907', chatType: 'group', messageText: '/group_alerts GA-105 on', fromId: '999999999' });
        await groupAlertsCommand(ctx);
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
      });
    });

    describe('unregistered -> denied', () => {
      it('denies unregistered group', async () => {
        customerService.create({ clientId: 'GA-106', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        const ctx = makeContext({ userId: '123456789', chatId: '-100999999999', chatType: 'group', messageText: '/group_alerts GA-106 on', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('not registered'));
      });
    });

    describe('private -> denied', () => {
      it('denies private chat', async () => {
        customerService.create({ clientId: 'GA-107', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        const ctx = makeContext({ userId: '123456789', chatId: '123456789', chatType: 'private', messageText: '/group_alerts GA-107 on', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('This command only works in groups'));
      });
    });
  });

  describe('Global Group', () => {
    describe('admin + existing client + on => explicit subscription', () => {
      it('creates explicit subscription without can_view', async () => {
        const customer = customerService.create({ clientId: 'GA-108', name: 'Global Client', monitorType: 'prtg', pingHost: null, enabled: true });
        
        const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', messageText: '/group_alerts GA-108 on', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Alert subscription enabled'));
      });
    });

    describe('off => disabled', () => {
      it('disables subscription', async () => {
        const customer = customerService.create({ clientId: 'GA-109', name: 'Global Client', monitorType: 'prtg', pingHost: null, enabled: true });
        const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', messageText: '/group_alerts GA-109 off', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Alert subscription disabled'));
      });
    });

    describe('no can_view row needed', () => {
      it('does not require can_view row', async () => {
        const customer = customerService.create({ clientId: 'GA-110', name: 'Global Client', monitorType: 'prtg', pingHost: null, enabled: true });
        const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', messageText: '/group_alerts GA-110 on', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('enabled'));
      });
    });

    describe('Global visibility still all after alert OFF', () => {
      it('visibility remains config-based', async () => {
        customerService.create({ clientId: 'GA-111', name: 'Global Client', monitorType: 'prtg', pingHost: null, enabled: true });
        
        // Enable then disable
        const ctx1 = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', messageText: '/group_alerts GA-111 on', fromId: '123456789' });
        await groupAlertsCommand(ctx1);
        
        const ctx2 = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', messageText: '/group_alerts GA-111 off', fromId: '123456789' });
        await groupAlertsCommand(ctx2);
        
        // Global Group visibility still all
        const { accessService } = await import('@/modules/groups/access.service');
        const scope = accessService.getCustomerAccessScope({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup' });
        expect(scope.kind).toBe('all');
      });
    });

    describe('non-admin -> denied', () => {
      it('denies non-admin', async () => {
        customerService.create({ clientId: 'GA-112', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        const ctx = makeContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup', messageText: '/group_alerts GA-112 on', fromId: '999999999' });
        await groupAlertsCommand(ctx);
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
      });
    });

    describe('unknown client -> not found', () => {
      it('returns not found', async () => {
        const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', messageText: '/group_alerts UNKNOWN on', fromId: '123456789' });
        await groupAlertsCommand(ctx);
        expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Customer not found'));
      });
    });
  });

  describe('Explicitly test: Global visibility != automatic alerts', () => {
    it('Global visibility does not auto-enable alerts', async () => {
      const customer = customerService.create({ clientId: 'GA-113', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      
      // Customer is globally visible but alerts should be off by default
      const { accessService } = await import('@/modules/groups/access.service');
      const canReceive = accessService.canReceiveAlerts({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup' }, customer.id);
      expect(canReceive).toBe(false);
    });
  });

  // Regression: R1 - group alerts on ineligible group stops before lookup
  describe('regression: existence leakage prevention', () => {
    it('unregistered group stops before customer lookup', async () => {
      const customer = customerService.create({ clientId: 'EXISTING-GA', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      
      // Unregistered group - should stop at group registration check
      const ctx1 = makeContext({ userId: '123456789', chatId: '-100111111900', chatType: 'supergroup', messageText: '/group_alerts EXISTING-GA on', fromId: '123456789' });
      await groupAlertsCommand(ctx1);
      
      // Should deny at group registration check
      expect(ctx1.reply).toHaveBeenCalledWith(expect.stringContaining('not registered'));
      
      // Missing customer in same unregistered group should get same response
      const ctx2 = makeContext({ userId: '123456789', chatId: '-100111111900', chatType: 'supergroup', messageText: '/group_alerts NONEXISTENT on', fromId: '123456789' });
      await groupAlertsCommand(ctx2);
      
      expect(ctx2.reply).toHaveBeenCalledWith(expect.stringContaining('not registered'));
    });

    it('disabled ordinary group stops before customer lookup', async () => {
      const customer = customerService.create({ clientId: 'EXISTING-GA-2', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111901', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111901', customerId: customer.id, canView: true, receiveAlerts: false });
      groupRepository.setEnabled('-100111111901', false);
      
      // Disabled group - should stop at group enabled check
      const ctx1 = makeContext({ userId: '123456789', chatId: '-100111111901', chatType: 'supergroup', messageText: '/group_alerts EXISTING-GA-2 on', fromId: '123456789' });
      await groupAlertsCommand(ctx1);
      
      expect(ctx1.reply).toHaveBeenCalledWith(expect.stringContaining('not registered'));
      
      // Missing customer in same disabled group should get same response
      const ctx2 = makeContext({ userId: '123456789', chatId: '-100111111901', chatType: 'supergroup', messageText: '/group_alerts NONEXISTENT on', fromId: '123456789' });
      await groupAlertsCommand(ctx2);
      
      expect(ctx2.reply).toHaveBeenCalledWith(expect.stringContaining('not registered'));
    });
  });
});