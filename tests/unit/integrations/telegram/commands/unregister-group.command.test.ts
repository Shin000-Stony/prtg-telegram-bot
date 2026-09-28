import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { unregisterGroupCommand } from '@/integrations/telegram/commands/unregister-group.command';
import { accessService } from '@/modules/groups/access.service';
import { groupService } from '@/modules/groups/group.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/unregister_group command', () => {
  let testDbPath: string;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-urg-'));
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

  describe('Initial command', () => {
    it('registered ordinary admin -> confirmation', async () => {
      groupService.register('-100111111401', 'Registered Group');
      const ctx = makeContext({ userId: '123456789', chatId: '-100111111401', chatType: 'group', chatTitle: 'Registered Group', fromId: '123456789' });
      await unregisterGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('UNREGISTER GROUP'),
        expect.objectContaining({ reply_markup: expect.any(Object) })
      );
    });

    it('non-admin -> denied', async () => {
      groupService.register('-100111111402', 'Registered Group');
      const ctx = makeContext({ userId: '999999999', chatId: '-100111111402', chatType: 'group', chatTitle: 'Registered Group', fromId: '999999999' });
      await unregisterGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    });

    it('Global Group -> informational', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup', fromId: '123456789' });
      await unregisterGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('cannot be unregistered'));
    });

    it('unregistered ordinary -> safe response', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '-100999999999', chatType: 'group', chatTitle: 'Unregistered', fromId: '123456789' });
      await unregisterGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('not registered'));
    });

    it('private -> wrong context', async () => {
      const ctx = makeContext({ userId: '123456789', chatId: '123456789', chatType: 'private', fromId: '123456789' });
      await unregisterGroupCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('This command only works in groups'));
    });
  });
});