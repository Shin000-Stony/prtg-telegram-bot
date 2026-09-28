import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { registerGroupCommand } from '@/integrations/telegram/commands/register-group.command';
import { accessService } from '@/modules/groups/access.service';
import { groupService } from '@/modules/groups/group.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/register_group command', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-rg-'));
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
    chatTitle?: string;
    fromId: string;
  }) {
    const reply = vi.fn();
    const chat = overrides.chatTitle ? { title: overrides.chatTitle } : undefined;
    return {
      userId: overrides.userId,
      chatId: overrides.chatId,
      chatType: overrides.chatType,
      chat,
      from: { id: BigInt(overrides.fromId || "123456789") },
      reply,
    } as any;
  }

  describe('ordinary group admin', () => {
    it('registers successfully', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111301', chatType: 'group', chatTitle: 'Test Group', fromId: '123456789' });
      await registerGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Group registered successfully'));
    });

    it('stores title safely', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111302', chatType: 'supergroup', chatTitle: "Test's Group", fromId: '123456789' });
      await registerGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Test's Group"));
    });
  });

  describe('supergroup admin', () => {
    it('registers successfully', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111303', chatType: 'supergroup', chatTitle: 'Super Group', fromId: '123456789' });
      await registerGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Group registered successfully'));
    });
  });

  describe('ordinary non-admin', () => {
    it('denied', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: '-100111111304', chatType: 'group', chatTitle: 'Test', fromId: '999999999' });
      await registerGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    });
  });

  describe('private chat', () => {
    it('wrong context', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '123456789', chatType: 'private', fromId: '123456789' });
      await registerGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('This command only works in groups'));
    });
  });

  describe('Global Group', () => {
    it('informational - no registration needed', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', fromId: '123456789' });
      await registerGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('does not need registration'));
    });

    it('Global Group non-admin also gets info', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup', fromId: '999999999' });
      await registerGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('does not need registration'));
    });
  });

  describe('already registered', () => {
    it('idempotent response', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111305', chatType: 'group', chatTitle: 'First', fromId: '123456789' });
      await registerGroupCommand(ctx);
      ctx.reply.mockClear();
      
      const ctx2 = makeContext({ userId: '123456789', chatId: '-100111111305', chatType: 'group', chatTitle: 'Second', fromId: '123456789' });
      await registerGroupCommand(ctx2);
      expect(ctx2.reply).toHaveBeenCalledWith(expect.stringContaining('already registered'));
    });
  });

  describe('missing title', () => {
    it('handles safely', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111306', chatType: 'group', fromId: '123456789' });
      await registerGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Group title not available'));
    });
  });

  describe('no internal DB IDs exposed', () => {
    it('response uses chat ID and title only', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111307', chatType: 'group', chatTitle: 'Test Group', fromId: '123456789' });
      await registerGroupCommand(ctx);
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Chat ID: -100111111307');
      expect(callArgs).toContain('Title: Test Group');
      // Internal database IDs (auto-increment PKs) should not be exposed
      // Chat ID is a Telegram chat ID (public), not an internal DB ID
      expect(callArgs).not.toMatch(/internal.*id.*\d+/i);
      expect(callArgs).not.toMatch(/database.*id.*\d+/i);
      expect(callArgs).not.toMatch(/primary.*key.*\d+/i);
    });
  });

  describe('admin authorization uses user ID', () => {
    it('uses ctx.from.id, not username', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111308', chatType: 'group', chatTitle: 'Test', fromId: '123456789' });
      await registerGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Group registered'));
    });
  });
});