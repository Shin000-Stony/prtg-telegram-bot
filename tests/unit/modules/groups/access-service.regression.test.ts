import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { accessService } from '@/modules/groups/access.service';
import { groupService } from '@/modules/groups/group.service';
import { groupRepository } from '@/modules/groups/group.repository';
import { customerService } from '@/modules/customers/customer.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('AccessService Regression Tests', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-asr-'));
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

  function makeContext(overrides: { userId: string; chatId: string; chatType: string } = {}) {
    return {
      userId: overrides.userId || 'user1',
      chatId: overrides.chatId || '123456789',
      chatType: overrides.chatType || 'private',
    };
  }

  describe('Base access matrix', () => {
    it('Private admin -> all', () => {
      const context = makeContext({ userId: 'admin1', chatId: '123456789', chatType: 'private' });
      expect(accessService.canManageCustomers(context)).toBe(true);
      expect(accessService.getCustomerAccessScope(context).kind).toBe('all');
    });

    it('Global Group non-admin -> cannot manage, but can read', () => {
      const context = makeContext({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' });
      expect(accessService.canManageCustomers(context)).toBe(false);
      expect(accessService.getCustomerAccessScope(context).kind).toBe('all');
    });

    it('Registered group -> assigned', () => {
      const customer = customerService.create({ clientId: 'ASR-1', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111112201', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111112201', customerId: customer.id, canView: true, receiveAlerts: false });
      
      const context = makeContext({ userId: 'user1', chatId: '-100111112201', chatType: 'group' });
      const scope = accessService.getCustomerAccessScope(context);
      expect(scope.kind).toBe('assigned');
      expect(scope.customerIds).toContain(customer.id);
    });

    it('Unregistered group -> none', () => {
      const context = makeContext({ userId: 'user1', chatId: '-100999999999', chatType: 'group' });
      expect(accessService.getCustomerAccessScope(context).kind).toBe('none');
    });

    it('Non-admin private -> none', () => {
      const context = makeContext({ userId: 'user1', chatId: '123456789', chatType: 'private' });
      expect(accessService.getCustomerAccessScope(context).kind).toBe('none');
    });
  });

  describe('V3 action combinations', () => {
    it('assign -> visible', () => {
      const customer = customerService.create({ clientId: 'ASR-2', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111112202', 'Test Group');
      
      groupService.assignCustomer({ groupChatId: '-100111112202', customerId: customer.id, canView: true, receiveAlerts: false });
      
      const context = makeContext({ userId: 'user1', chatId: '-100111112202', chatType: 'group' });
      const canView = accessService.canViewCustomer(context, customer.id);
      expect(canView).toBe(true);
    });

    it('unassign -> hidden', () => {
      const customer = customerService.create({ clientId: 'ASR-3', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111112203', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111112203', customerId: customer.id, canView: true, receiveAlerts: false });
      
      groupService.unassignCustomer('-100111112203', customer.id);
      
      const context = makeContext({ userId: 'user1', chatId: '-100111112203', chatType: 'group' });
      const canView = accessService.canViewCustomer(context, customer.id);
      expect(canView).toBe(false);
    });

    it('alert-only row with can_view=0 does NOT make ordinary client visible', () => {
      const customer = customerService.create({ clientId: 'ASR-4', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111112204', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111112204', customerId: customer.id, canView: false, receiveAlerts: true });
      
      const context = makeContext({ userId: 'user1', chatId: '-100111112204', chatType: 'group' });
      const canView = accessService.canViewCustomer(context, customer.id);
      expect(canView).toBe(false);
    });

    it('Global Group remains visible regardless of row state', () => {
      const customer = customerService.create({ clientId: 'ASR-5', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      
      // Add alert subscription for Global Group
      groupRepository.assignCustomer({ groupChatId: '-1001234567890', customerId: customer.id, canView: false, receiveAlerts: true });
      groupRepository.assignCustomer({ groupChatId: '-1001234567890', customerId: customer.id, canView: false, receiveAlerts: false });
      
      const context = makeContext({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' });
      const scope = accessService.getCustomerAccessScope(context);
      expect(scope.kind).toBe('all');
    });
  });
});