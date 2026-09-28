import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting, getDatabase } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { accessService } from '@/modules/groups/access.service';
import { groupRepository } from '@/modules/groups/group.repository';
import { customerService } from '@/modules/customers/customer.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Global Group Persistence Verification', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-ggp-'));
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

  describe('1. No Global DB row: visibility and access', () => {
    it('isGlobalGroup(chatId) is still true without DB row', () => {
      expect(accessService.isGlobalGroup('-1001234567890')).toBe(true);
    });

    it('access scope is all without DB row', () => {
      const context = { userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' };
      const scope = accessService.getCustomerAccessScope(context);
      expect(scope.kind).toBe('all');
    });

    it('canViewCustomer returns true without DB row', () => {
      const context = { userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' };
      expect(accessService.canViewCustomer(context, 1)).toBe(true);
    });

    it('canReceiveAlerts returns false without subscription', () => {
      const context = { userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' };
      expect(accessService.canReceiveAlerts(context, 1)).toBe(false);
    });
  });

  describe('2. First Global alert ON: persistence row and alert row', () => {
    it('may create persistence row for FK integrity', () => {
      const customer = customerService.create({ clientId: 'GG-1', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      const customerId = customer.id;
      
      // Ensure Global Group has a telegram_groups row for FK integrity
      groupRepository.upsert('-1001234567890', 'Global Group');
      
      // Add alert subscription for Global Group
      groupRepository.getDb().prepare(`
        INSERT INTO group_customer_access (group_chat_id, customer_id, can_view, receive_alerts, created_at, updated_at)
        VALUES (?, ?, 0, 1, datetime('now'), datetime('now'))
        ON CONFLICT(group_chat_id, customer_id) DO UPDATE SET receive_alerts = excluded.receive_alerts
      `).run('-1001234567890', customerId);
      
      // Check if telegram_groups row exists (lightweight)
      const db = getDatabase();
      const row = db.prepare('SELECT * FROM telegram_groups WHERE chat_id = ?').get('-1001234567890');
      // Row may or may not exist - either is acceptable
      
      // Alert row exists
      const access = groupRepository.getAccess('-1001234567890', customerId);
      expect(access).not.toBeNull();
      expect(access?.receiveAlerts).toBe(true);
    });

    it('visibility remains config-based', () => {
      const customer = customerService.create({ clientId: 'GG-2', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      const customerId = customer.id;
      
      // Ensure Global Group has a telegram_groups row for FK integrity
      groupRepository.upsert('-1001234567890', 'Global Group');
      
      // Add alert subscription
      groupRepository.getDb().prepare(`
        INSERT INTO group_customer_access (group_chat_id, customer_id, can_view, receive_alerts, created_at, updated_at)
        VALUES (?, ?, 0, 1, datetime('now'), datetime('now'))
        ON CONFLICT(group_chat_id, customer_id) DO UPDATE SET receive_alerts = excluded.receive_alerts
      `).run('-1001234567890', customerId);
      
      // Visibility still all
      const context = { userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' };
      const scope = accessService.getCustomerAccessScope(context);
      expect(scope.kind).toBe('all');
      
      // canView still true
      expect(accessService.canViewCustomer({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' }, customerId)).toBe(true);
    });
  });

  describe('3. Removing/disabling persistence row does not alter isGlobalGroup', () => {
    it('isGlobalGroup still true even if telegram_groups row removed', () => {
      // Add alert subscription first
      const customer = customerService.create({ clientId: 'GG-3', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      
      // Ensure Global Group has a telegram_groups row for FK integrity
      groupRepository.upsert('-1001234567890', 'Global Group');
      
      groupRepository.getDb().prepare(`
        INSERT INTO group_customer_access (group_chat_id, customer_id, can_view, receive_alerts, created_at, updated_at)
        VALUES (?, ?, 0, 1, datetime('now'), datetime('now'))
      `).run('-1001234567890', customer.id);
      
      // Remove telegram_groups row if it exists
      getDatabase().prepare('DELETE FROM telegram_groups WHERE chat_id = ?').run('-1001234567890');
      
      // isGlobalGroup still true
      expect(accessService.isGlobalGroup('-1001234567890')).toBe(true);
      
      // Access scope still all
      const scope = accessService.getCustomerAccessScope({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' });
      expect(scope.kind).toBe('all');
    });
  });

  describe('4. Alert OFF preserves visibility', () => {
    it('customer remains globally visible after alert OFF', () => {
      const customer = customerService.create({ clientId: 'GG-4', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      const customerId = customer.id;
      
      // Ensure Global Group has a telegram_groups row for FK integrity
      groupRepository.upsert('-1001234567890', 'Global Group');
      
      // Enable alert
      groupRepository.getDb().prepare(`
        INSERT INTO group_customer_access (group_chat_id, customer_id, can_view, receive_alerts, created_at, updated_at)
        VALUES (?, ?, 0, 1, datetime('now'), datetime('now'))
      `).run('-1001234567890', customerId);
      
      // Disable alert
      groupRepository.getDb().prepare(`
        UPDATE group_customer_access SET receive_alerts = 0 WHERE group_chat_id = ? AND customer_id = ?
      `).run('-1001234567890', customerId);
      
      // Visibility still all
      const scope = accessService.getCustomerAccessScope({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' });
      expect(scope.kind).toBe('all');
      
      // canView still true
      expect(accessService.canViewCustomer({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' }, customerId)).toBe(true);
      
      // canReceiveAlerts now false
      expect(accessService.canReceiveAlerts({ userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' }, customerId)).toBe(false);
    });
  });
});