import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { groupRepository } from '@/modules/groups/group.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Customer Mutation Authorization', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-mut-'));
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
    runMigrations();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  function createContext(overrides: Partial<{ userId: string; chatId: string; chatType: string }> = {}) {
    return {
      userId: overrides.userId || 'user1',
      chatId: overrides.chatId || '123456789',
      chatType: overrides.chatType || 'private',
    };
  }

  describe('canManageCustomers', () => {
    describe('PRIVATE ADMIN', () => {
      it('allows mutations', () => {
        const context = createContext({ userId: 'admin1', chatId: '123456789', chatType: 'private' });
        expect(accessService.canManageCustomers(context)).toBe(true);
      });
    });

    describe('GLOBAL GROUP ADMIN', () => {
      it('allows mutations', () => {
        const context = createContext({ userId: 'admin1', chatId: '-1001234567890', chatType: 'supergroup' });
        expect(accessService.canManageCustomers(context)).toBe(true);
      });
    });

    describe('GLOBAL GROUP NON-ADMIN', () => {
      it('denies mutations', () => {
        const context = createContext({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' });
        expect(accessService.canManageCustomers(context)).toBe(false);
      });
    });

    describe('ORDINARY GROUP ADMIN', () => {
      it('denies mutations', () => {
        const customer = customerService.create({ clientId: 'MUT-ADMIN', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
        groupRepository.upsert('-100999999999', 'Ord Group');
        groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: true, receiveAlerts: true });
        const context = createContext({ userId: 'user1', chatId: '-100999999999', chatType: 'group' });
        expect(accessService.canManageCustomers(context)).toBe(false);
      });
    });

    describe('ORDINARY GROUP NON-ADMIN', () => {
      it('denies mutations', () => {
        groupRepository.upsert('-100999999999', 'Ord Group');
        const context = createContext({ userId: 'user1', chatId: '-100999999999', chatType: 'group' });
        expect(accessService.canManageCustomers(context)).toBe(false);
      });
    });

    describe('UNREGISTERED GROUP', () => {
      it('denies mutations', () => {
        const context = createContext({ userId: 'user1', chatId: '-100888888888', chatType: 'group' });
        expect(accessService.canManageCustomers(context)).toBe(false);
      });
    });

    describe('NON-ADMIN PRIVATE', () => {
      it('denies mutations', () => {
        const context = createContext({ userId: 'user1', chatId: '999999999', chatType: 'private' });
        expect(accessService.canManageCustomers(context)).toBe(false);
      });
    });
  });

  describe('Global Group membership never grants admin', () => {
    it('global group non-admin is not admin', () => {
      expect(accessService.isAdmin('user1')).toBe(false);
    });

    it('global group admin is admin', () => {
      expect(accessService.isAdmin('admin1')).toBe(true);
    });
  });

  describe('canViewCustomer uses central access logic', () => {
    it('admin can view any customer', () => {
      const context = createContext({ userId: 'admin1', chatId: '123456789', chatType: 'private' });
      expect(accessService.canViewCustomer(context, 1)).toBe(true);
    });

    it('global group member can view any customer', () => {
      const context = createContext({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' });
      expect(accessService.canViewCustomer(context, 1)).toBe(true);
    });

    it('non-admin private chat cannot view', () => {
      const context = createContext({ userId: 'user1', chatId: '123456789', chatType: 'private' });
      expect(accessService.canViewCustomer(context, 1)).toBe(false);
    });

    it('unregistered group cannot view', () => {
      const context = createContext({ userId: 'user1', chatId: '-100888888888', chatType: 'group' });
      expect(accessService.canViewCustomer(context, 1)).toBe(false);
    });
  });

  describe('canReceiveAlerts is independent of canView', () => {
    it('global group without alert subscription cannot receive alerts', () => {
      const context = createContext({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' });
      expect(accessService.canReceiveAlerts(context, 1)).toBe(false);
    });

    it('global group with explicit subscription can receive alerts', () => {
      const customer = customerService.create({ clientId: 'MUT-1', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupRepository.upsert('-1001234567890', 'Global Group');
      groupRepository.assignCustomer({ groupChatId: '-1001234567890', customerId: customer.id, canView: true, receiveAlerts: true });
      const context = createContext({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' });
      expect(accessService.canReceiveAlerts(context, customer.id)).toBe(true);
    });

    it('canView does not imply receiveAlerts', () => {
      const customer = customerService.create({ clientId: 'MUT-2', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupRepository.upsert('-100999999999', 'Ord Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: true, receiveAlerts: false });
      const context = createContext({ userId: 'user1', chatId: '-100999999999', chatType: 'group' });
      expect(accessService.canViewCustomer(context, customer.id)).toBe(true);
      expect(accessService.canReceiveAlerts(context, customer.id)).toBe(false);
    });

    it('receiveAlerts does not imply canView for ordinary group', () => {
      const customer = customerService.create({ clientId: 'MUT-3', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupRepository.upsert('-100999999999', 'Ord Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: false, receiveAlerts: true });
      const context = createContext({ userId: 'user1', chatId: '-100999999999', chatType: 'group' });
      expect(accessService.canViewCustomer(context, customer.id)).toBe(false);
      expect(accessService.canReceiveAlerts(context, customer.id)).toBe(true);
    });
  });
});