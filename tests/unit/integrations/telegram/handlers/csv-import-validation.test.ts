import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { handleCsvDocument } from '@/integrations/telegram/handlers/csv-import.handler';
import { accessService } from '@/modules/groups/access.service';
import { getConfig } from '@/config/env';
import { CSV_MAX_FILE_BYTES } from '@/modules/imports/csv-import.types';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('File Validation Tests', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-fileval-'));
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

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('client_id,name,monitor_type,ping_host\n101,Test,prtg,\n102,Test2,icmp,10.0.0.1')
    }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetConfigForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  function createMockContext(overrides: Partial<{
    userId: string;
    chatId: string;
    chatType: string;
    message: { document: { file_name: string; file_size: number; mime_type: string; file_id: string } };
    telegram: { getFile: ReturnType<typeof vi.fn> };
    reply: ReturnType<typeof vi.fn>;
  }> = {}) {
    const reply = vi.fn();
    const getFile = vi.fn().mockResolvedValue({ file_path: 'test.csv' });
    return {
      userId: overrides.userId || 'admin1',
      chatId: overrides.chatId || '123456789',
      chatType: overrides.chatType || 'private',
      message: overrides.message || { document: { file_name: 'test.csv', file_size: 100, mime_type: 'text/csv', file_id: 'file123' } },
      telegram: { getFile: overrides.telegram?.getFile || vi.fn().mockResolvedValue({ file_path: 'test.csv' }) },
      reply: vi.fn(),
      ...overrides,
    } as any;
  }

  describe('CSV extension validation', () => {
    it('accepts .csv extension', async () => {
      const ctx = createMockContext({ 
        userId: '123456789', 
        chatId: '123456789', 
        chatType: 'private',
        message: { document: { file_name: 'test.csv', file_size: 100, mime_type: 'text/csv', file_id: 'file123' } }
      });
      await handleCsvDocument(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    it('accepts .CSV extension (uppercase)', async () => {
      const ctx = createMockContext({ 
        userId: '123456789', 
        chatId: '123456789', 
        chatType: 'private',
        message: { document: { file_name: 'test.CSV', file_size: 100, mime_type: 'text/csv', file_id: 'file123' } }
      });
      await handleCsvDocument(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    it('rejects non-CSV extension', async () => {
      const ctx = createMockContext({ 
        userId: '123456789', 
        chatId: '123456789', 
        chatType: 'private',
        message: { document: { file_name: 'test.txt', file_size: 100, mime_type: 'text/plain', file_id: 'file123' } }
      });
      await handleCsvDocument(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Please upload a .csv file');
    });

    it('rejects .xlsx extension', async () => {
      const ctx = createMockContext({ 
        userId: '123456789', 
        chatId: '123456789', 
        chatType: 'private',
        message: { document: { file_name: 'test.xlsx', file_size: 100, mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', file_id: 'file123' } }
      });
      await handleCsvDocument(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Please upload a .csv file');
    });
  });

  describe('File size validation', () => {
    it('accepts file within size limit', async () => {
      const ctx = createMockContext({ 
        userId: '123456789', 
        chatId: '123456789', 
        chatType: 'private',
        message: { document: { file_name: 'test.csv', file_size: CSV_MAX_FILE_BYTES - 1, mime_type: 'text/csv', file_id: 'file123' } }
      });
      await handleCsvDocument(ctx);
      expect(ctx.reply).toHaveBeenCalled();
    });

    it('rejects file over size limit', async () => {
      const ctx = createMockContext({ 
        userId: '123456789', 
        chatId: '123456789', 
        chatType: 'private',
        message: { document: { file_name: 'test.csv', file_size: CSV_MAX_FILE_BYTES + 1, mime_type: 'text/csv', file_id: 'file123' } }
      });
      await handleCsvDocument(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('File too large');
    });

    it('rejects empty file', async () => {
      const ctx = createMockContext({ 
        userId: '123456789', 
        chatId: '123456789', 
        chatType: 'private',
        message: { document: { file_name: 'test.csv', file_size: 0, mime_type: 'text/csv', file_id: 'file123' } }
      });
      await handleCsvDocument(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Empty file');
    });
  });

  describe('MIME type validation', () => {
    it('accepts non-CSV MIME if extension is .csv (extension takes precedence)', async () => {
      const ctx = createMockContext({ 
        userId: '123456789', 
        chatId: '123456789', 
        chatType: 'private',
        message: { document: { file_name: 'test.csv', file_size: 100, mime_type: 'application/pdf', file_id: 'file123' } }
      });
      await handleCsvDocument(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      // Extension takes precedence over MIME type
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('CSV IMPORT PREVIEW');
    });
  });

  describe('Authorization', () => {
    it('rejects non-admin in private chat', async () => {
      const ctx = createMockContext({ 
        userId: '999999999', 
        chatId: '123456789', 
        chatType: 'private',
        message: { document: { file_name: 'test.csv', file_size: 100, mime_type: 'text/csv', file_id: 'file123' } }
      });
      await handleCsvDocument(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('admin privileges');
    });

    it('rejects non-admin in group', async () => {
      const ctx = createMockContext({ 
        userId: '999999999', 
        chatId: '-100999999999', 
        chatType: 'group',
        message: { document: { file_name: 'test.csv', file_size: 100, mime_type: 'text/csv', file_id: 'file123' } }
      });
      await handleCsvDocument(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('admin privileges');
    });

    it('denies global group non-admin', async () => {
      const ctx = createMockContext({ 
        userId: '999999999', 
        chatId: '-1001234567890', 
        chatType: 'supergroup',
        message: { document: { file_name: 'test.csv', file_size: 100, mime_type: 'text/csv', file_id: 'file123' } }
      });
      await handleCsvDocument(ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('admin privileges');
    });
  });
});