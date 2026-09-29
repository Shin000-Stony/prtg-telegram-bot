import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { csvUploadCommand, csvUploadCaption } from '@/integrations/telegram/commands/csv-upload.command';
import { accessService } from '@/modules/groups/access.service';
import { ALL_HEADERS } from '@/modules/imports/csv-import.types';
import { MONITOR_TYPES } from '@/config/constants';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UTF8_BOM = '\uFEFF';

describe('csvUploadCommand', () => {
  let testDir: string;
  let testDbPath: string;

  const ADMIN_USER_ID = '123456789';
  const GLOBAL_GROUP_ID = '-1001234567890';

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-csvupload-'));
    testDbPath = join(testDir, 'test.db');
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', ADMIN_USER_ID);
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', GLOBAL_GROUP_ID);
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
    vi.restoreAllMocks();
    resetConfigForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  function createMockContext(overrides: Partial<{
    userId: string;
    chatId: string;
    chatType: string;
  }> = {}) {
    const reply = vi.fn().mockResolvedValue(undefined);
    const replyWithDocument = vi.fn().mockResolvedValue(undefined);
    return {
      userId: overrides.userId || ADMIN_USER_ID,
      chatId: overrides.chatId || GLOBAL_GROUP_ID,
      chatType: overrides.chatType || 'private',
      reply,
      replyWithDocument,
    } as any;
  }

  describe('Authorization', () => {
    it('allows admin in private chat', async () => {
      vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
      const ctx = createMockContext({ userId: ADMIN_USER_ID, chatType: 'private' });
      await csvUploadCommand(ctx);
      expect(ctx.replyWithDocument).toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('allows admin in global group', async () => {
      vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
      const ctx = createMockContext({ userId: ADMIN_USER_ID, chatId: GLOBAL_GROUP_ID, chatType: 'supergroup' });
      await csvUploadCommand(ctx);
      expect(ctx.replyWithDocument).toHaveBeenCalled();
    });

    it('rejects non-admin', async () => {
      vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(false);
      const ctx = createMockContext({ userId: '999999999', chatType: 'private' });
      await csvUploadCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('admin privileges'),
      );
      expect(ctx.replyWithDocument).not.toHaveBeenCalled();
    });
  });

  describe('Template file content', () => {
    it('sends document with correct filename', async () => {
      vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
      const ctx = createMockContext();
      await csvUploadCommand(ctx);

      const docArg = ctx.replyWithDocument.mock.calls[0][0];
      expect(docArg.filename).toBe('customer_import_template.csv');
    });

    it('sends document with UTF-8 BOM prefix', async () => {
      vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
      const ctx = createMockContext();
      await csvUploadCommand(ctx);

      const docArg = ctx.replyWithDocument.mock.calls[0][0];
      const buffer = docArg.source as Buffer;
      const content = buffer.toString('utf-8');
      expect(content.startsWith(UTF8_BOM)).toBe(true);
    });

    it('contains correct headers matching ALL_HEADERS constant', async () => {
      vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
      const ctx = createMockContext();
      await csvUploadCommand(ctx);

      const docArg = ctx.replyWithDocument.mock.calls[0][0];
      const buffer = docArg.source as Buffer;
      const content = buffer.toString('utf-8');
      const headerLine = content.split('\n')[0].replace(UTF8_BOM, '').trim();
      expect(headerLine).toBe(ALL_HEADERS.join(','));
    });

    it('uses CRLF line endings', async () => {
      vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
      const ctx = createMockContext();
      await csvUploadCommand(ctx);

      const docArg = ctx.replyWithDocument.mock.calls[0][0];
      const buffer = docArg.source as Buffer;
      const content = buffer.toString('utf-8');
      expect(content).toContain('\r\n');
    });

    it('sends caption with required columns, allowed values, and warning', async () => {
      vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
      const ctx = createMockContext();
      await csvUploadCommand(ctx);

      const captionArg = ctx.replyWithDocument.mock.calls[0][1].caption;
      expect(captionArg).toContain('Required columns');
      expect(captionArg).toContain('Optional columns');
      expect(captionArg).toContain('Allowed monitor_type values');
      expect(MONITOR_TYPES.join(', ')).toBe('prtg, icmp, pic, disabled');
      expect(captionArg).toContain('prtg, icmp, pic, disabled');
      expect(captionArg).toContain('Save as CSV');
    });
  });

  describe('csvUploadCaption export', () => {
    it('includes all required headers in caption text', () => {
      expect(csvUploadCaption).toContain('client_id');
      expect(csvUploadCaption).toContain('name');
      expect(csvUploadCaption).toContain('monitor_type');
    });

    it('includes monitor type values', () => {
      expect(csvUploadCaption).toContain('prtg');
      expect(csvUploadCaption).toContain('icmp');
      expect(csvUploadCaption).toContain('pic');
      expect(csvUploadCaption).toContain('disabled');
    });
  });
});
