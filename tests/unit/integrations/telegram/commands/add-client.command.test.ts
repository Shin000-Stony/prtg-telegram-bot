import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { addClientCommand } from '@/integrations/telegram/commands/add-client.command';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/add_client command', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-addclient-'));
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

  function createMockContext(overrides: Partial<{
    userId: string;
    chatId: string;
    chatType: string;
    message: { text: string };
    reply: ReturnType<typeof vi.fn>;
  }> = {}) {
    const reply = vi.fn();
    return {
      userId: overrides.userId || 'user1',
      chatId: overrides.chatId || '123456789',
      chatType: overrides.chatType || 'private',
      message: overrides.message || { text: '/add_client 101 | Test | prtg' },
      reply,
      ...overrides,
    } as any;
  }

  describe('authorization', () => {
    it('allows PRIVATE ADMIN', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client 101 | Test | prtg' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    it('allows GLOBAL GROUP ADMIN', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', message: { text: '/add_client 101 | Test | prtg' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    it('denies GLOBAL GROUP NON-ADMIN', async () => {
      const ctx = createMockContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup', messageText: '/add_client 101 | Test | prtg', fromId: '999999999' });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Access denied');
    });

    it('denies ORDINARY GROUP', async () => {
      const ctx = createMockContext({ userId: '999999999', chatId: '-100999999999', chatType: 'group', message: { text: '/add_client 101 | Test | prtg' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Access denied');
    });

    it('denies NON-ADMIN PRIVATE', async () => {
      const ctx = createMockContext({ userId: '999999999', chatId: '999999999', chatType: 'private', message: { text: '/add_client 101 | Test | prtg' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Access denied');
    });
  });

  describe('validation', () => {
    beforeEach(async () => {
      testDir = await mkdtemp(join(tmpdir(), 'prtg-test-addclient-val-'));
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

    it('valid PRTG customer', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client 101 | Test PRTG | prtg' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Customer created');
      expect(callArgs).toContain('101');
      expect(callArgs).toContain('PRTG');
    });

    it('valid ICMP customer with ping_host', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client 102 | Test ICMP | icmp | 192.0.2.10' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Customer created');
      expect(callArgs).toContain('102');
      expect(callArgs).toContain('ICMP');
      expect(callArgs).toContain('192.0.2.10');
    });

    it('missing client_id', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client | Test | prtg' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Client ID is required');
    });

    it('missing name', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client 101 | | prtg' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Name is required');
    });

    it('missing monitor_type', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client 101 | Test |' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Invalid enum value');
    });

    it('invalid monitor_type', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client 101 | Test | invalid' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Invalid enum value');
    });

    it('ICMP without ping_host rejected', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client 101 | Test | icmp' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('ping_host is required for ICMP');
    });

    it('duplicate client_id rejected', async () => {
      customerService.create({ clientId: '101', name: 'Existing', monitorType: 'prtg', pingHost: null, enabled: true });
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client 101 | Duplicate | prtg' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Client ID already exists');
    });

    it('trims client_id', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client  101  |  Test  |  prtg  ' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('101');
    });

    it('trims customer name', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client 101 |  Test Name  |  prtg' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Test Name');
    });

    it('malformed separator syntax shows usage', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client 101 Test prtg' } });
      await addClientCommand(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Usage: /add_client');
    });

    it('malformed input performs no DB write', async () => {
      const beforeCount = customerRepository.count();
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/add_client invalid' } });
      await addClientCommand(ctx);
      const afterCount = customerRepository.count();
      expect(afterCount).toBe(beforeCount);
    });
  });
});