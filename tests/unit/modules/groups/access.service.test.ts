import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { accessService } from '@/modules/groups/access.service';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { groupRepository } from '@/modules/groups/group.repository';
import { customerRepository } from '@/modules/customers/customer.repository';

function setupEnv() {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('LOG_LEVEL', 'info');
  vi.stubEnv('TZ', 'Asia/Makassar');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
  vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1,admin2');
  vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
  vi.stubEnv('DATABASE_PATH', ':memory:');
  vi.stubEnv('PRTG_BASE_URL', '');
  vi.stubEnv('PRTG_USERNAME', '');
  vi.stubEnv('PRTG_PASSHASH', '');
  vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
}

describe('Access Service', () => {
  beforeEach(() => {
    setupEnv();
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
  });

  describe('isAdmin', () => {
    it('returns true for configured admin', () => {
      expect(accessService.isAdmin('admin1')).toBe(true);
      expect(accessService.isAdmin('admin2')).toBe(true);
    });

    it('returns false for non-admin', () => {
      expect(accessService.isAdmin('user1')).toBe(false);
      expect(accessService.isAdmin('')).toBe(false);
    });

    it('handles empty admin list', () => {
      vi.stubEnv('TELEGRAM_ADMIN_IDS', '');
      resetConfigForTesting();
      expect(accessService.isAdmin('any')).toBe(false);
    });
  });

  describe('isPrivateChat', () => {
    it('returns true for private', () => {
      expect(accessService.isPrivateChat('private')).toBe(true);
    });

    it('returns false for group', () => {
      expect(accessService.isPrivateChat('group')).toBe(false);
    });

    it('returns false for supergroup', () => {
      expect(accessService.isPrivateChat('supergroup')).toBe(false);
    });

    it('returns false for channel', () => {
      expect(accessService.isPrivateChat('channel')).toBe(false);
    });
  });

  describe('isGroupChat', () => {
    it('returns true for group', () => {
      expect(accessService.isGroupChat('group')).toBe(true);
    });

    it('returns true for supergroup', () => {
      expect(accessService.isGroupChat('supergroup')).toBe(true);
    });

    it('returns false for private', () => {
      expect(accessService.isGroupChat('private')).toBe(false);
    });

    it('returns false for channel', () => {
      expect(accessService.isGroupChat('channel')).toBe(false);
    });
  });

  describe('isGlobalGroup', () => {
    it('returns true for exact match', () => {
      expect(accessService.isGlobalGroup('-1001234567890')).toBe(true);
    });

    it('returns false for different ID', () => {
      expect(accessService.isGlobalGroup('-1001234567891')).toBe(false);
      expect(accessService.isGlobalGroup('1234567890')).toBe(false);
    });

    it('returns false when not configured', () => {
      vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '');
      resetConfigForTesting();
      expect(accessService.isGlobalGroup('-1001234567890')).toBe(false);
    });

    it('uses exact string comparison', () => {
      expect(accessService.isGlobalGroup('-1001234567890 ')).toBe(false);
      expect(accessService.isGlobalGroup(' -1001234567890')).toBe(false);
    });
  });

  describe('canManageCustomers', () => {
    it('returns true for admin in private chat', () => {
      expect(accessService.canManageCustomers({
        userId: 'admin1',
        chatId: '123456789',
        chatType: 'private',
      })).toBe(true);
    });

    it('returns true for admin in global group', () => {
      expect(accessService.canManageCustomers({
        userId: 'admin1',
        chatId: '-1001234567890',
        chatType: 'supergroup',
      })).toBe(true);
    });

    it('returns false for admin in ordinary group', () => {
      expect(accessService.canManageCustomers({
        userId: 'admin1',
        chatId: '-100999999999',
        chatType: 'group',
      })).toBe(false);
    });

    it('returns false for global group non-admin member', () => {
      expect(accessService.canManageCustomers({
        userId: 'user1',
        chatId: '-1001234567890',
        chatType: 'supergroup',
      })).toBe(false);
    });

    it('returns false for regular user in regular group', () => {
      expect(accessService.canManageCustomers({
        userId: 'user1',
        chatId: '-100999999999',
        chatType: 'group',
      })).toBe(false);
    });

    it('returns false for regular user in private chat', () => {
      expect(accessService.canManageCustomers({
        userId: 'user1',
        chatId: '123456789',
        chatType: 'private',
      })).toBe(false);
    });
  });

  describe('canViewCustomer', () => {
    it('returns true for admin in registered group with access', () => {
      const customer = customerRepository.create({
        clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
      });
      groupRepository.upsert('-100999999999', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: true, receiveAlerts: false });

      expect(accessService.canViewCustomer({
        userId: 'admin1',
        chatId: '-100999999999',
        chatType: 'group',
      }, customer.id)).toBe(true);
    });

    it('returns true for global group', () => {
      expect(accessService.canViewCustomer({
        userId: 'user1',
        chatId: '-1001234567890',
        chatType: 'supergroup',
      }, 1)).toBe(true);
    });

    it('returns false for private chat', () => {
      expect(accessService.canViewCustomer({
        userId: 'user1',
        chatId: '123456789',
        chatType: 'private',
      }, 1)).toBe(false);
    });

    it('returns true when group has access', () => {
      const customer = customerRepository.create({
        clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
      });
      groupRepository.upsert('-100999999999', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: true, receiveAlerts: false });

      expect(accessService.canViewCustomer({
        userId: 'user1',
        chatId: '-100999999999',
        chatType: 'group',
      }, customer.id)).toBe(true);
    });

    it('returns false when group has no access', () => {
      const customer = customerRepository.create({
        clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
      });
      groupRepository.upsert('-100999999999', 'Test Group');

      expect(accessService.canViewCustomer({
        userId: 'user1',
        chatId: '-100999999999',
        chatType: 'group',
      }, customer.id)).toBe(false);
    });

    it('returns false when can_view is false', () => {
      const customer = customerRepository.create({
        clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
      });
      groupRepository.upsert('-100999999999', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: false, receiveAlerts: true });

      expect(accessService.canViewCustomer({
        userId: 'user1',
        chatId: '-100999999999',
        chatType: 'group',
      }, customer.id)).toBe(false);
    });
  });

  describe('canReceiveAlerts', () => {
    it('returns true for admin in registered group with subscription', () => {
      const customer = customerRepository.create({
        clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
      });
      groupRepository.upsert('-100999999999', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: true, receiveAlerts: true });

      expect(accessService.canReceiveAlerts({
        userId: 'admin1',
        chatId: '-100999999999',
        chatType: 'group',
      }, customer.id)).toBe(true);
    });

    it('returns false for global group without explicit subscription', () => {
      expect(accessService.canReceiveAlerts({
        userId: 'user1',
        chatId: '-1001234567890',
        chatType: 'supergroup',
      }, 1)).toBe(false);
    });

    it('returns true for global group with explicit receive_alerts subscription', () => {
      const customer = customerRepository.create({
        clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
      });
      groupRepository.upsert('-1001234567890', 'Global Group');
      groupRepository.assignCustomer({ groupChatId: '-1001234567890', customerId: customer.id, canView: true, receiveAlerts: true });

      expect(accessService.canReceiveAlerts({
        userId: 'user1',
        chatId: '-1001234567890',
        chatType: 'supergroup',
      }, customer.id)).toBe(true);
    });

    it('returns true when group has receive_alerts', () => {
      const customer = customerRepository.create({
        clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
      });
      groupRepository.upsert('-100999999999', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: true, receiveAlerts: true });

      expect(accessService.canReceiveAlerts({
        userId: 'user1',
        chatId: '-100999999999',
        chatType: 'group',
      }, customer.id)).toBe(true);
    });

    it('returns false when group has can_view but not receive_alerts', () => {
      const customer = customerRepository.create({
        clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
      });
      groupRepository.upsert('-100999999999', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: true, receiveAlerts: false });

      expect(accessService.canReceiveAlerts({
        userId: 'user1',
        chatId: '-100999999999',
        chatType: 'group',
      }, customer.id)).toBe(false);
    });

    it('global group membership does not imply admin', () => {
      expect(accessService.isAdmin('user1')).toBe(false);
    });
  });

  describe('getCustomerAccessScope', () => {
    it('returns all for private admin', () => {
      const scope = accessService.getCustomerAccessScope({
        userId: 'admin1',
        chatId: '123456789',
        chatType: 'private',
      });
      expect(scope).toEqual({ kind: 'all' });
    });

    it('returns assigned for admin in registered ordinary group', () => {
      groupRepository.upsert('-100999999999', 'Test Group');
      const scope = accessService.getCustomerAccessScope({
        userId: 'admin1',
        chatId: '-100999999999',
        chatType: 'group',
      });
      expect(scope.kind).toBe('assigned');
    });

    it('returns all for global group member', () => {
      const scope = accessService.getCustomerAccessScope({
        userId: 'user1',
        chatId: '-1001234567890',
        chatType: 'supergroup',
      });
      expect(scope).toEqual({ kind: 'all' });
    });

    it('returns none for non-admin private chat', () => {
      const scope = accessService.getCustomerAccessScope({
        userId: 'user1',
        chatId: '123456789',
        chatType: 'private',
      });
      expect(scope).toEqual({ kind: 'none' });
    });

    it('returns none for unregistered group', () => {
      const scope = accessService.getCustomerAccessScope({
        userId: 'user1',
        chatId: '-100999999999',
        chatType: 'group',
      });
      expect(scope).toEqual({ kind: 'none' });
    });

    it('returns assigned for registered ordinary group with access', () => {
      const customer = customerRepository.create({
        clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
      });
      groupRepository.upsert('-100999999999', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: true, receiveAlerts: false });

      const scope = accessService.getCustomerAccessScope({
        userId: 'user1',
        chatId: '-100999999999',
        chatType: 'group',
      });
      expect(scope).toEqual({ kind: 'assigned', customerIds: [customer.id] });
    });

    it('returns assigned with multiple customers', () => {
      const customer1 = customerRepository.create({
        clientId: 'C001', name: 'Test1', monitorType: 'prtg', pingHost: null, enabled: true
      });
      const customer2 = customerRepository.create({
        clientId: 'C002', name: 'Test2', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true
      });
      groupRepository.upsert('-100999999999', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer1.id, canView: true, receiveAlerts: false });
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer2.id, canView: true, receiveAlerts: true });

      const scope = accessService.getCustomerAccessScope({
        userId: 'user1',
        chatId: '-100999999999',
        chatType: 'group',
      });
      expect(scope.kind).toBe('assigned');
      expect((scope as { kind: 'assigned'; customerIds: number[] }).customerIds).toEqual(expect.arrayContaining([customer1.id, customer2.id]));
    });

    // Regression: disabled ordinary group has none scope for all users
    it('returns none for disabled ordinary group (admin and non-admin)', () => {
      groupRepository.upsert('-100999999999', 'Test Group');
      groupRepository.setEnabled('-100999999999', false);
      
      const scopeAdmin = accessService.getCustomerAccessScope({
        userId: 'admin1',
        chatId: '-100999999999',
        chatType: 'group',
      });
      const scopeNonAdmin = accessService.getCustomerAccessScope({
        userId: 'user1',
        chatId: '-100999999999',
        chatType: 'group',
      });
      
      expect(scopeAdmin.kind).toBe('none');
      expect(scopeNonAdmin.kind).toBe('none');
    });

    // Regression: unregistered ordinary group has none scope for all users
    it('returns none for unregistered ordinary group (admin and non-admin)', () => {
      // Don't create group - it's unregistered
      
      const scopeAdmin = accessService.getCustomerAccessScope({
        userId: 'admin1',
        chatId: '-100999999998',
        chatType: 'group',
      });
      const scopeNonAdmin = accessService.getCustomerAccessScope({
        userId: 'user1',
        chatId: '-100999999998',
        chatType: 'group',
      });
      
      expect(scopeAdmin.kind).toBe('none');
      expect(scopeNonAdmin.kind).toBe('none');
    });
  });

  describe('canReceiveAlerts regression', () => {
    // Regression: Global admin without explicit subscription cannot receive alerts
    it('returns false for global admin without explicit subscription', () => {
      expect(accessService.canReceiveAlerts({
        userId: 'admin1',
        chatId: '-1001234567890',
        chatType: 'supergroup',
      }, 1)).toBe(false);
    });

    // Regression: Disabled ordinary group with subscription row cannot receive alerts
    it('returns false for disabled ordinary group even with subscription row', () => {
      const customer = customerRepository.create({
        clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
      });
      groupRepository.upsert('-100999999999', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: true, receiveAlerts: true });
      groupRepository.setEnabled('-100999999999', false);
      
      expect(accessService.canReceiveAlerts({
        userId: 'admin1',
        chatId: '-100999999999',
        chatType: 'group',
      }, customer.id)).toBe(false);
    });

    // Regression: Unregistered ordinary group with subscription row cannot receive alerts
    it('returns false for unregistered ordinary group even with subscription row', () => {
      const customer = customerRepository.create({
        clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
      });
      groupRepository.upsert('-100999999998', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999998', customerId: customer.id, canView: true, receiveAlerts: true });
      // Group is not enabled (unregistered)
      groupRepository.setEnabled('-100999999998', false);
      
      expect(accessService.canReceiveAlerts({
        userId: 'admin1',
        chatId: '-100999999998',
        chatType: 'group',
      }, customer.id)).toBe(false);
    });
  });
});