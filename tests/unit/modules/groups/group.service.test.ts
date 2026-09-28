import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { groupService } from '@/modules/groups/group.service';
import { groupRepository } from '@/modules/groups/group.repository';
import { customerService } from '@/modules/customers/customer.service';
import { accessService } from '@/modules/groups/access.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('GroupService', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-gs-'));
    testDbPath = join(testDir, 'test.db');
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1,admin2');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('DATABASE_PATH', testDbPath);
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('registerGroup', () => {
    it('registers new ordinary group', () => {
      const group = groupService.register('-100111111111', 'Test Group');
      expect(group.chatId).toBe('-100111111111');
      expect(group.title).toBe('Test Group');
      expect(group.enabled).toBe(true);
    });

    it('is idempotent for already registered group', () => {
      groupService.register('-100222222222', 'First Title');
      const group = groupService.register('-100222222222', 'Second Title');
      expect(group.title).toBe('Second Title'); // title updated
      expect(group.enabled).toBe(true);
    });

    it('re-enables disabled group', () => {
      groupRepository.upsert('-100333333333', 'Disabled Group');
      groupRepository.getDb().prepare('UPDATE telegram_groups SET enabled = 0 WHERE chat_id = ?').run('-100333333333');
      
      const group = groupService.register('-100333333333', 'Re-enabled Group');
      expect(group.enabled).toBe(true);
      expect(group.title).toBe('Re-enabled Group');
    });

    it('handles missing title safely', () => {
      const group = groupService.register('-100444444444', null);
      expect(group.title).toBeNull();
    });

    it('stores title safely (no SQL injection)', () => {
      const group = groupService.register('-100555555555', "Test ' Group");
      expect(group.title).toBe("Test ' Group");
    });

    it('does not create duplicate rows', () => {
      groupService.register('-100666666666', 'Test');
      groupService.register('-100666666666', 'Test');
      
      const count = groupRepository.getDb().prepare('SELECT COUNT(*) as c FROM telegram_groups WHERE chat_id = ?').get('-100666666666') as { c: number };
      expect(count.c).toBe(1);
    });
  });

  describe('unregisterGroup', () => {
    it('unregisters registered group', () => {
      groupService.register('-100777777777', 'To Unregister');
      const success = groupService.unregisterGroup('-100777777777');
      expect(success).toBe(true);
      expect(groupRepository.findByChatId('-100777777777')).toBeNull();
    });

    it('is safe/idempotent for unregistered group', () => {
      const success = groupService.unregisterGroup('-100888888888');
      expect(success).toBe(false);
    });

    it('removes dependent access rows', () => {
      const customer = customerService.create({ clientId: 'UG-1', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100999999999', 'With Access');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: true, receiveAlerts: true });
      
      groupService.unregisterGroup('-100999999999');
      
      const accessRows = groupRepository.getDb().prepare('SELECT * FROM group_customer_access WHERE group_chat_id = ?').all('-100999999999');
      expect(accessRows.length).toBe(0);
    });

    it('does not control Global Group identity via DB', () => {
      const isGlobal = accessService.isGlobalGroup('-1001234567890');
      expect(isGlobal).toBe(true);
      
      // Even if we unregister, Global Group identity remains config-based
      groupService.unregisterGroup('-1001234567890');
      expect(accessService.isGlobalGroup('-1001234567890')).toBe(true);
    });
  });

  describe('assignCustomer', () => {
    it('assigns existing customer', () => {
      const customer = customerService.create({ clientId: 'AC-1', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111112', 'Test Group');
      
      const access = groupService.assignCustomer({ groupChatId: '-100111111112', customerId: customer.id, canView: true, receiveAlerts: false });
      
      expect(access.canView).toBe(true);
      expect(access.receiveAlerts).toBe(false);
    });

    it('sets can_view to 1', () => {
      const customer = customerService.create({ clientId: 'AC-2', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111113', 'Test Group');
      
      groupService.assignCustomer({ groupChatId: '-100111111113', customerId: customer.id, canView: true, receiveAlerts: false });
      
      const access = groupRepository.getAccess('-100111111113', customer.id);
      expect(access?.canView).toBe(true);
    });

    it('preserves receive_alerts=0', () => {
      const customer = customerService.create({ clientId: 'AC-3', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111114', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111114', customerId: customer.id, canView: false, receiveAlerts: 0 });
      
      groupService.assignCustomer({ groupChatId: '-100111111114', customerId: customer.id, canView: true, receiveAlerts: false });
      
      const access = groupRepository.getAccess('-100111111114', customer.id);
      expect(access?.receiveAlerts).toBe(false);
    });

    it('preserves receive_alerts=1', () => {
      const customer = customerService.create({ clientId: 'AC-4', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111115', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111115', customerId: customer.id, canView: false, receiveAlerts: 1 });
      
      groupService.assignCustomer({ groupChatId: '-100111111115', customerId: customer.id, canView: true, receiveAlerts: 0 });
      
      const access = groupRepository.getAccess('-100111111115', customer.id);
      expect(access?.receiveAlerts).toBe(true);
    });

    it('is idempotent for duplicate assignment', () => {
      const customer = customerService.create({ clientId: 'AC-5', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111116', 'Test Group');
      groupService.assignCustomer({ groupChatId: '-100111111116', customerId: customer.id, canView: true, receiveAlerts: false });
      groupService.assignCustomer({ groupChatId: '-100111111116', customerId: customer.id, canView: true, receiveAlerts: false });
      
      const count = groupRepository.getDb().prepare('SELECT COUNT(*) as c FROM group_customer_access WHERE group_chat_id = ? AND customer_id = ?').get('-100111111116', customer.id) as { c: number };
      expect(count.c).toBe(1);
    });
  });

  describe('unassignCustomer', () => {
    it('clears can_view', () => {
      const customer = customerService.create({ clientId: 'UC-1', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111117', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111117', customerId: customer.id, canView: true, receiveAlerts: false });
      
      const result = groupService.unassignCustomer('-100111111117', customer.id);
      expect(result.canView).toBe(false);
    });

    it('receive_alerts=0 triggers zero/zero cleanup', () => {
      const customer = customerService.create({ clientId: 'UC-2', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111118', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111118', customerId: customer.id, canView: true, receiveAlerts: false });
      
      groupService.unassignCustomer('-100111111118', customer.id);
      
      const access = groupRepository.getAccess('-100111111118', customer.id);
      expect(access).toBeNull(); // zero/zero cleanup
    });

    it('receive_alerts=1 preserves row with can_view=0', () => {
      const customer = customerService.create({ clientId: 'UC-3', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111119', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111119', customerId: customer.id, canView: true, receiveAlerts: true });
      
      const result = groupService.unassignCustomer('-100111111119', customer.id);
      expect(result.canView).toBe(false);
      expect(result.receiveAlerts).toBe(true);
      
      const access = groupRepository.getAccess('-100111111119', customer.id);
      expect(access?.canView).toBe(false);
      expect(access?.receiveAlerts).toBe(true);
    });

    it('is idempotent for duplicate unassign', () => {
      const customer = customerService.create({ clientId: 'UC-4', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111120', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111120', customerId: customer.id, canView: true, receiveAlerts: false });
      
      groupService.unassignCustomer('-100111111120', customer.id);
      const result = groupService.unassignCustomer('-100111111120', customer.id);
      expect(result.canView).toBe(false);
    });
  });

  describe('setAlertSubscription', () => {
    describe('Ordinary group', () => {
      it('visible + ON => receive_alerts=1', () => {
        const customer = customerService.create({ clientId: 'SA-1', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.register('-100200000001', 'Test Group');
        groupRepository.assignCustomer({ groupChatId: '-100200000001', customerId: customer.id, canView: true, receiveAlerts: false });
        
        const access = groupService.setAlertSubscription('-100200000001', customer.id, true);
        expect(access.receiveAlerts).toBe(true);
      });

      it('visible + OFF => 0', () => {
        const customer = customerService.create({ clientId: 'SA-2', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.register('-100200000002', 'Test Group');
        groupRepository.assignCustomer({ groupChatId: '-100200000002', customerId: customer.id, canView: true, receiveAlerts: true });
        
        const access = groupService.setAlertSubscription('-100200000002', customer.id, false);
        expect(access.receiveAlerts).toBe(false);
      });

      it('hidden + ON => allowed (explicit subscription without visibility)', () => {
        const customer = customerService.create({ clientId: 'SA-3', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.register('-100200000003', 'Test Group');
        groupRepository.assignCustomer({ groupChatId: '-100200000003', customerId: customer.id, canView: false, receiveAlerts: false });
        
        const access = groupService.setAlertSubscription('-100200000003', customer.id, true);
        expect(access.receiveAlerts).toBe(true);
        expect(access.canView).toBe(false);
      });

      it('hidden stale + OFF => allowed', () => {
        const customer = customerService.create({ clientId: 'SA-4', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.register('-100200000004', 'Test Group');
        groupRepository.assignCustomer({ groupChatId: '-100200000004', customerId: customer.id, canView: false, receiveAlerts: true });
        
        const access = groupService.setAlertSubscription('-100200000004', customer.id, false);
        expect(access.receiveAlerts).toBe(false);
      });
    });

    describe('Global Group', () => {
      it('ON works without can_view assignment', () => {
        const customer = customerService.create({ clientId: 'SA-5', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        
        const access = groupService.setAlertSubscription('-1001234567890', customer.id, true);
        expect(access.receiveAlerts).toBe(true);
      });

      it('OFF works', () => {
        const customer = customerService.create({ clientId: 'SA-6', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.setAlertSubscription('-1001234567890', customer.id, true);
        
        const access = groupService.setAlertSubscription('-1001234567890', customer.id, false);
        expect(access.receiveAlerts).toBe(false);
      });

      it('visibility remains config-based', () => {
        const customer = customerService.create({ clientId: 'SA-7', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.setAlertSubscription('-1001234567890', customer.id, true);
        groupService.setAlertSubscription('-1001234567890', customer.id, false);
        
        const scope = accessService.getCustomerAccessScope({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' });
        expect(scope.kind).toBe('all');
      });

      it('explicit alert row does not become visibility source', () => {
        const customer = customerService.create({ clientId: 'SA-8', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        groupService.setAlertSubscription('-1001234567890', customer.id, true);
        groupService.setAlertSubscription('-1001234567890', customer.id, false);
        
        const scope = accessService.getCustomerAccessScope({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' });
        expect(scope.kind).toBe('all');
      });
    });
  });
});