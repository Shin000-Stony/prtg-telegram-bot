import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { enableClientCommand, disableClientCommand } from '@/integrations/telegram/commands/client-state.command';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/enable_client and /disable_client commands', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-state-'));
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
      message: overrides.message || { text: '/enable_client CLI-1' },
      reply,
      ...overrides,
    } as any;
  }

  describe('/enable_client', () => {
    it('enables a disabled customer - PRIVATE ADMIN', async () => {
      const customer = customerService.create({ clientId: 'EN-1', name: 'Test Enable', monitorType: 'prtg', pingHost: null, enabled: false });
      expect(customer.enabled).toBe(false);

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/enable_client EN-1' } });
      await enableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Customer enabled');
      expect(callArgs).toContain('EN-1');

      const updated = customerService.getByClientId('EN-1');
      expect(updated?.enabled).toBe(true);
    });

    it('enables a disabled customer - GLOBAL GROUP ADMIN', async () => {
      const customer = customerService.create({ clientId: 'EN-2', name: 'Test Enable GG', monitorType: 'prtg', pingHost: null, enabled: false });

      const ctx = createMockContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', message: { text: '/enable_client EN-2' } });
      await enableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Customer enabled');
    });

    it('denies GLOBAL GROUP NON-ADMIN', async () => {
      const customer = customerService.create({ clientId: 'EN-3', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: false });
      const ctx = createMockContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup', message: { text: '/enable_client EN-3' } });
      await enableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Access denied');
    });

    it('denies ORDINARY GROUP', async () => {
      const customer = customerService.create({ clientId: 'EN-4', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: false });
      const ctx = createMockContext({ userId: '999999999', chatId: '-100999999999', chatType: 'group', message: { text: '/enable_client EN-4' } });
      await enableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Access denied');
    });

    it('denies NON-ADMIN PRIVATE', async () => {
      const customer = customerService.create({ clientId: 'EN-5', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: false });
      const ctx = createMockContext({ userId: '999999999', chatId: '999999999', chatType: 'private', message: { text: '/enable_client EN-5' } });
      await enableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Access denied');
    });

    it('unknown client returns not found', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/enable_client UNKNOWN' } });
      await enableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Customer not found');
    });

    it('already enabled customer shows warning', async () => {
      customerService.create({ clientId: 'EN-6', name: 'Already Enabled', monitorType: 'prtg', pingHost: null, enabled: true });
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/enable_client EN-6' } });
      await enableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('already enabled');
    });

    it('missing argument shows usage', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/enable_client' } });
      await enableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Usage: /enable_client <client_id>');
    });
  });

  describe('/disable_client', () => {
    it('disables an enabled customer - PRIVATE ADMIN', async () => {
      const customer = customerService.create({ clientId: 'DIS-1', name: 'Test Disable', monitorType: 'prtg', pingHost: null, enabled: true });
      expect(customer.enabled).toBe(true);

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/disable_client DIS-1' } });
      await disableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Customer disabled');
      expect(callArgs).toContain('DIS-1');

      const updated = customerService.getByClientId('DIS-1');
      expect(updated?.enabled).toBe(false);
    });

    it('disables an enabled customer - GLOBAL GROUP ADMIN', async () => {
      const customer = customerService.create({ clientId: 'DIS-2', name: 'Test Disable GG', monitorType: 'prtg', pingHost: null, enabled: true });
      const ctx = createMockContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', message: { text: '/disable_client DIS-2' } });
      await disableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Customer disabled');
    });

    it('denies GLOBAL GROUP NON-ADMIN', async () => {
      const customer = customerService.create({ clientId: 'DIS-3', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      const ctx = createMockContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup', message: { text: '/disable_client DIS-3' } });
      await disableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Access denied');
    });

    it('unknown client returns not found', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/disable_client UNKNOWN' } });
      await disableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Customer not found');
    });

    it('already disabled customer shows warning', async () => {
      customerService.create({ clientId: 'DIS-4', name: 'Already Disabled', monitorType: 'prtg', pingHost: null, enabled: false });
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/disable_client DIS-4' } });
      await disableClientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('already disabled');
    });

    it('does not delete customer or mapping or access rows', async () => {
      const customer = customerService.create({ clientId: 'DIS-5', name: 'Test No Delete', monitorType: 'prtg', pingHost: null, enabled: true });
      const beforeCount = customerRepository.count();

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/disable_client DIS-5' } });
      await disableClientCommand(ctx);

      const afterCount = customerRepository.count();
      expect(afterCount).toBe(beforeCount);

      const updated = customerService.getByClientId('DIS-5');
      expect(updated?.enabled).toBe(false);
    });
  });
});