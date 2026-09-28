import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { helpCommand } from '@/integrations/telegram/commands/help.command';
import { accessService } from '@/modules/groups/access.service';
import { groupService } from '@/modules/groups/group.service';
import { getConfig } from '@/config/env';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/help context tests', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-help-'));
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

  function makeContext(overrides: { userId: string; chatId: string; chatType: string; fromId?: string } = {}) {
    const reply = vi.fn();
    return {
      userId: overrides.userId,
      chatId: overrides.chatId,
      chatType: overrides.chatType,
      from: { id: BigInt(overrides.fromId || overrides.userId) },
      reply,
    } as any;
  }

  describe('Private admin', () => {
    it('shows V2 customer-management commands', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/clients');
      expect(callArgs).toContain('/client');
      expect(callArgs).toContain('/add_client');
      expect(callArgs).toContain('/enable_client');
      expect(callArgs).toContain('/disable_client');
      expect(callArgs).toContain('/csv_upload');
    });

    it('does not show group commands in private', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('/register_group');
      expect(callArgs).not.toContain('/group_clients');
      expect(callArgs).not.toContain('/group_alerts');
    });
  });

  describe('Global admin', () => {
    it('shows /clients, /client, /add_client, /enable_client, /disable_client', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/clients');
      expect(callArgs).toContain('/client');
      expect(callArgs).toContain('/add_client');
      expect(callArgs).toContain('/enable_client');
      expect(callArgs).toContain('/disable_client');
    });

    it('shows /group_clients', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/group_clients');
    });

    it('shows /group_alerts', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/group_alerts');
    });

    it('shows /chatid and /help', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/chatid');
      expect(callArgs).toContain('/help');
    });

    it('shows /csv_upload', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/csv_upload');
    });
  });

  describe('Global non-admin', () => {
    it('shows read-only: /clients, /client', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/clients');
      expect(callArgs).toContain('/client');
    });

    it('shows /group_clients', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/group_clients');
    });

    it('shows /chatid and /help', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/chatid');
      expect(callArgs).toContain('/help');
    });

    it('does not show mutation commands', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('/add_client');
      expect(callArgs).not.toContain('/enable_client');
      expect(callArgs).not.toContain('/disable_client');
    });
  });

  describe('Registered ordinary admin', () => {
    it('shows /clients, /client', async () => {
      groupService.register('-100111112301', 'Test Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112301', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/clients');
      expect(callArgs).toContain('/client');
    });

    it('shows /group_clients', async () => {
      groupService.register('-100111112301', 'Test Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112301', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/group_clients');
    });

    it('shows /assign_client', async () => {
      groupService.register('-100111112301', 'Test Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112301', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/assign_client');
    });

    it('shows /unassign_client', async () => {
      groupService.register('-100111112301', 'Test Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112301', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/unassign_client');
    });

    it('shows /group_alerts', async () => {
      groupService.register('-100111112301', 'Test Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112301', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/group_alerts');
    });

    it('shows /unregister_group', async () => {
      groupService.register('-100111112301', 'Test Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112301', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/unregister_group');
    });

    it('shows /chatid and /help', async () => {
      groupService.register('-100111112301', 'Test Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112301', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/chatid');
      expect(callArgs).toContain('/help');
    });

    it('does not show /register_group for registered group', async () => {
      groupService.register('-100111112301', 'Test Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112301', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('/register_group');
    });
  });

  describe('Registered ordinary non-admin', () => {
    it('read-only: /clients, /client', async () => {
      groupService.register('-100111112302', 'Test Group');
      const ctx = makeContext({ userId: '999999999', chatId: '-100111112302', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/clients');
      expect(callArgs).toContain('/client');
    });

    it('shows /group_clients', async () => {
      groupService.register('-100111112302', 'Test Group');
      const ctx = makeContext({ userId: '999999999', chatId: '-100111112302', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/group_clients');
    });

    it('shows /chatid and /help', async () => {
      groupService.register('-100111112302', 'Test Group');
      const ctx = makeContext({ userId: '999999999', chatId: '-100111112302', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/chatid');
      expect(callArgs).toContain('/help');
    });

    it('does not show mutation commands', async () => {
      groupService.register('-100111112302', 'Test Group');
      const ctx = makeContext({ userId: '999999999', chatId: '-100111112302', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('/assign_client');
      expect(callArgs).not.toContain('/unassign_client');
      expect(callArgs).not.toContain('/group_alerts');
      expect(callArgs).not.toContain('/unregister_group');
    });
  });

  describe('Unregistered ordinary admin', () => {
    it('shows /register_group', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112303', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/register_group');
    });

    it('shows /chatid and /help', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112303', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/chatid');
      expect(callArgs).toContain('/help');
    });
  });

  describe('Unregistered ordinary non-admin', () => {
    it('shows /chatid and /help only', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: '-100999999999', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/chatid');
      expect(callArgs).toContain('/help');
    });

    it('does not expose customer commands', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: '-100999999999', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('/clients');
      expect(callArgs).not.toContain('/client');
    });
  });

  describe('Verify mutation commands not advertised to non-admin', () => {
    it('Global non-admin does not see mutations', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('/add_client');
      expect(callArgs).not.toContain('/enable_client');
      expect(callArgs).not.toContain('/disable_client');
    });

    it('Registered non-admin does not see mutations', async () => {
      groupService.register('-100111112302', 'Test Group');
      const ctx = makeContext({ userId: '999999999', chatId: '-100111112302', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('/assign_client');
      expect(callArgs).not.toContain('/unassign_client');
      expect(callArgs).not.toContain('/group_alerts');
      expect(callArgs).not.toContain('/unregister_group');
    });
  });

  describe('/register_group shown to unregistered admin', () => {
    it('shown in unregistered group for admin', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112303', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/register_group');
    });
  });

  describe('/group_alerts shown where appropriate', () => {
    it('shown for Global admin', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/group_alerts');
    });

    it('shown for Registered admin', async () => {
      groupService.register('-100111112301', 'Test Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112301', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('/group_alerts');
    });

    it('not shown for non-admin', async () => {
      groupService.register('-100111112302', 'Test Group');
      const ctx = makeContext({ userId: '999999999', chatId: '-100111112302', chatType: 'group' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('/group_alerts');
    });
  });

  describe('Global Group help says assignment unnecessary', () => {
    it('Global admin help mentions global group', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('global group admin');
    });

    it('Global non-admin help mentions global group', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('read-only');
    });
  });

  describe('Private help does not pretend group-local commands work there', () => {
    it('private admin help does not show group commands as working in private', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await helpCommand(ctx);
      
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('/register_group');
      expect(callArgs).not.toContain('/group_clients');
      expect(callArgs).not.toContain('/group_alerts');
    });
  });

  describe('HTML escaping of descriptions', () => {
    it('escapes <client_id> placeholder in Global Group admin help', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup' });
      await helpCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('<client_id>');
      expect(callArgs).toContain('&lt;client_id&gt;');
      expect(callArgs).toContain('/group_alerts');
    });

    it('escapes <client_id> placeholder in registered group admin help', async () => {
      groupService.register('-100111112301', 'Test Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111112301', chatType: 'group' });
      await helpCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('<client_id>');
      expect(callArgs).toContain('&lt;client_id&gt;');
    });

    it('preserves HTML structure tags (b, code)', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await helpCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('<b>');
      expect(callArgs).toContain('<code>');
      expect(callArgs).toContain('<i>');
    });
  });
});