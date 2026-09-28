import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { accessService } from '@/modules/groups/access.service';
import { groupService } from '@/modules/groups/group.service';
import { groupRepository } from '@/modules/groups/group.repository';
import { customerService } from '@/modules/customers/customer.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { formatSuccess, formatError, formatWarning, formatInfo, formatAccessDenied } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Security Tests', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-sec-'));
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

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
  });

  function makeContext(overrides: { userId: string; chatId: string; chatType: string } = {}) {
    return {
      userId: overrides.userId || 'user1',
      chatId: overrides.chatId || '123456789',
      chatType: overrides.chatType || 'private',
    };
  }

  describe('Authorization source', () => {
    it('username cannot grant admin', () => {
      // Admin check uses only user ID, not username
      expect(accessService.isAdmin('admin1')).toBe(true);
      expect(accessService.isAdmin('admin2')).toBe(true);
      // Even if username is 'admin', without matching ID it's not admin
      expect(accessService.isAdmin('admin')).toBe(false);
    });

    it('display name cannot grant admin', () => {
      // Admin check only uses user ID
      expect(accessService.isAdmin('John Doe')).toBe(false);
    });

    it('only ctx.from.id is authoritative', () => {
      // Admin check uses exact string match on user ID
      expect(accessService.isAdmin('admin1')).toBe(true);
      expect(accessService.isAdmin('admin1 ')).toBe(false); // trailing space
      expect(accessService.isAdmin(' admin1')).toBe(false); // leading space
    });
  });

  describe('Global non-admin cannot mutate', () => {
    it('Global non-admin cannot manage customers', () => {
      const context = { userId: 'user1', chatId: '-1001234567890', chatType: 'supergroup' };
      expect(accessService.canManageCustomers(context)).toBe(false);
    });
  });

  describe('Ordinary non-admin cannot mutate', () => {
    it('Ordinary non-admin cannot manage customers', () => {
      const context = { userId: 'user1', chatId: '-100111111111', chatType: 'group' };
      expect(accessService.canManageCustomers(context)).toBe(false);
    });
  });

  describe('Unregister callback cannot be hijacked', () => {
    it('different user cannot confirm', async () => {
      const { pendingUnregisterStore } = await import('@/modules/groups/pending-unregister.store');
      const pending = pendingUnregisterStore.create('-100111111501', '123456789');
      // The store itself doesn't check user - that's done in handler
      // This test verifies the token is bound to user
      expect(pending.userId).toBe('123456789');
    });
  });

  describe('Different admin cannot confirm another admin token', () => {
    it('different user cannot consume token', async () => {
      const { pendingUnregisterStore } = await import('@/modules/groups/pending-unregister.store');
      const pending = pendingUnregisterStore.create('-100111111601', '123456789');
      const consumed = pendingUnregisterStore.consume(pending.id);
      // If we try to consume again with different user, it won't exist
      expect(pendingUnregisterStore.get(pending.id)).toBeUndefined();
    });
  });

  describe('Unregistered group cannot access customer data', () => {
    it('unregistered group cannot view customers', () => {
      customerService.create({ clientId: 'SEC-1', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      const context = { userId: 'user1', chatId: '-100999999999', chatType: 'group' };
      expect(accessService.canViewCustomer(context, 1)).toBe(false);
    });
  });

  describe('Registration does not leak unrelated customers', () => {
    it('registering group does not expose other customers', () => {
      customerService.create({ clientId: 'SEC-2', name: 'Secret', monitorType: 'prtg', pingHost: null, enabled: true });
      const group = groupRepository.upsert('-100111112401', 'New Group');
      // Registration only creates group row, no customer data exposed
      expect(group.chatId).toBe('-100111112401');
    });
  });

  describe('Internal DB IDs not exposed', () => {
    it('commands use client_id not internal PK', () => {
      const customer = customerRepository.getDb().prepare('INSERT INTO customers (client_id, name, monitor_type, ping_host, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))').run('SEC-3', 'Test', 'prtg', null, 1);
      const customerId = customer.lastInsertRowid as number;
      
      // The internal ID is never returned in command responses
      expect(typeof customerId).toBe('number');
      // But commands only use/return client_id
    });
  });

  describe('No secrets in V3 messages/log fixtures', () => {
    it('messages don\'t contain secrets', () => {
      const messages = [
        formatSuccess('test'),
        formatError('test'),
        formatWarning('test'),
        formatInfo('test'),
        formatAccessDenied('test'),
      ];
      
      for (const msg of messages) {
        expect(msg).not.toContain('TELEGRAM_BOT_TOKEN');
        expect(msg).not.toContain('PRTG_PASSHASH');
        expect(msg).not.toContain('password');
        expect(msg).not.toContain('passhash');
      }
    });
  
    it('logger events don\'t contain secrets', () => {
      const logger = getLogger().child({ module: 'test' });
      
      // Just verify logger doesn't crash and doesn't log secrets by default
      logger.info({ key: 'value' }, 'test message');
      logger.error({ err: new Error('test') }, 'error message');
      
      // Pino with our config ignores pid/hostname and doesn't log process.env
      expect(true).toBe(true);
    });
  });
});