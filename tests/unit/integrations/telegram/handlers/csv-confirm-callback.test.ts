import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting, getDatabase } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { handleCsvConfirm, handleCsvCancel } from '@/integrations/telegram/handlers/csv-import.handler';
import { pendingImportStore } from '@/modules/imports/pending-import.store';
import { csvImportService } from '@/modules/imports/csv-import.service';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GLOBAL_GROUP_ID = '-1001234567890';

describe('CSV Confirm Callback', () => {
  const ADMIN_USER_ID = '123456789';
  const OTHER_USER_ID = '999999999';

  const validRows = [
    { clientId: '101', name: 'Test 1', monitorType: 'prtg' as const, pingHost: null, rowNumber: 1 },
    { clientId: '102', name: 'Test 2', monitorType: 'icmp' as const, pingHost: '10.0.0.1', rowNumber: 2 },
  ];

  const summary = {
    totalRows: 2,
    validCount: 2,
    errorCount: 0,
    newCount: 2,
    duplicateInCsv: 0,
    existingInDb: 0,
  };

  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-cb-'));
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
    resetMigrationsForTesting();
    runMigrations();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  function makeMockContext(overrides: {
    userId: string;
    chatId: string;
    chatType: string;
    callbackQueryData: string;
    fromId: string;
  }) {
    const answerCbQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    return {
      userId: overrides.userId,
      chatId: overrides.chatId,
      chatType: overrides.chatType,
      callbackQuery: {
        data: overrides.callbackQueryData,
        id: 'query1',
        from: { id: BigInt(overrides.fromId || overrides.userId) },
      },
      answerCbQuery,
      editMessageText,
    } as any;
  }

  describe('OWNER + SAME CHAT + AUTHORIZED -> import succeeds', () => {
    it('confirms and imports customers', async () => {
      const pending = pendingImportStore.create(GLOBAL_GROUP_ID, ADMIN_USER_ID, validRows, summary);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `csv_confirm:${token}`,
        fromId: ADMIN_USER_ID,
      });
      
      await handleCsvConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Importing...');
      expect(ctx.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Import completed'),
        { parse_mode: 'HTML' }
      );
      
      const imported = customerRepository.count();
      expect(imported).toBe(2);
    });
  });

  describe('DIFFERENT USER -> denied', () => {
    it('rejects different user', async () => {
      const pending = pendingImportStore.create(GLOBAL_GROUP_ID, ADMIN_USER_ID, validRows, summary);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '999999998',
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `csv_confirm:${token}`,
        fromId: '999999998',
      });
      
      await handleCsvConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Only the original uploader can confirm');
      // Handler returns early after answerCbQuery, editMessageText not called
    });
  });

  describe('DIFFERENT CHAT -> denied', () => {
    it('rejects different chat', async () => {
      const pending = pendingImportStore.create(GLOBAL_GROUP_ID, ADMIN_USER_ID, validRows, summary);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: '-999999',
        chatType: 'supergroup',
        callbackQueryData: `csv_confirm:${token}`,
        fromId: ADMIN_USER_ID,
      });
      
      await handleCsvConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('This import belongs to a different chat');
    });
  });

  describe('EXPIRED TOKEN -> denied', () => {
    it('rejects expired token', async () => {
      const pending = pendingImportStore.create(GLOBAL_GROUP_ID, ADMIN_USER_ID, validRows, summary);
      pending.expiresAt = new Date(Date.now() - 1000);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `csv_confirm:${token}`,
        fromId: ADMIN_USER_ID,
      });
      
      await handleCsvConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Import session expired or invalid');
      expect(ctx.editMessageText).toHaveBeenCalledWith('❌ Import session expired or invalid');
    });
  });

  describe('CANCELLED TOKEN -> denied', () => {
    it('rejects cancelled token', async () => {
      const pending = pendingImportStore.create(GLOBAL_GROUP_ID, ADMIN_USER_ID, validRows, summary);
      pendingImportStore.delete(pending.id);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `csv_confirm:${token}`,
        fromId: ADMIN_USER_ID,
      });
      
      await handleCsvConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Import session expired or invalid');
    });
  });

  describe('ALREADY CONSUMED -> cannot import twice', () => {
    it('rejects already consumed token', async () => {
      const pending = pendingImportStore.create(GLOBAL_GROUP_ID, ADMIN_USER_ID, validRows, summary);
      pendingImportStore.consume(pending.id);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `csv_confirm:${token}`,
        fromId: ADMIN_USER_ID,
      });
      
      await handleCsvConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Import session expired or invalid');
    });
  });

  describe('USER LOST AUTHORIZATION AFTER PREVIEW -> denied', () => {
    it('rejects if user no longer authorized', async () => {
      const pending = pendingImportStore.create(GLOBAL_GROUP_ID, ADMIN_USER_ID, validRows, summary);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '999999998',
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `csv_confirm:${token}`,
        fromId: '999999998',
      });
      
      await handleCsvConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Only the original uploader can confirm');
    });
  });

  describe('IMPORT DB FAILURE -> safe user error', () => {
    it('shows error and rolls back', async () => {
      const pending = pendingImportStore.create(GLOBAL_GROUP_ID, ADMIN_USER_ID, validRows, summary);
      const token = pending.id;
      
      // Make customer creation fail by inserting a duplicate first
      customerService.create({ clientId: '101', name: 'Existing', monitorType: 'prtg', pingHost: null, enabled: true });
      
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `csv_confirm:${token}`,
        fromId: ADMIN_USER_ID,
      });
      
      await handleCsvConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Importing...');
      expect(ctx.editMessageText).toHaveBeenCalledWith('❌ Import failed. See logs for details.');
    });
  });

  describe('ctx.answerCbQuery always called', () => {
    it('calls answerCbQuery on confirm', async () => {
      const pending = pendingImportStore.create(GLOBAL_GROUP_ID, ADMIN_USER_ID, validRows, summary);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `csv_confirm:${token}`,
        fromId: ADMIN_USER_ID,
      });
      
      await handleCsvConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalled();
    });

    it('calls answerCbQuery on cancel', async () => {
      const pending = pendingImportStore.create(GLOBAL_GROUP_ID, ADMIN_USER_ID, validRows, summary);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `csv_cancel:${token}`,
        fromId: ADMIN_USER_ID,
      });
      
      await handleCsvCancel(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalled();
    });

    it('calls answerCbQuery on invalid callback', async () => {
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: 'invalid_callback',
        fromId: ADMIN_USER_ID,
      });
      
await handleCsvConfirm(ctx);
       
       expect(ctx.answerCbQuery).toHaveBeenCalledWith('Invalid callback');
     });

    // Regression: CSV confirm with same owner but revoked admin permission
    it('denies same owner after admin permission revoked', async () => {
      const pending = pendingImportStore.create(GLOBAL_GROUP_ID, ADMIN_USER_ID, validRows, summary);
      const token = pending.id;
      const db = getDatabase();
      const beforeSnapshot = JSON.stringify(['customers'].map(t => db.prepare('SELECT * FROM ' + t).all()));
      
      // Revoke admin permission
      vi.stubEnv('TELEGRAM_ADMIN_IDS', '');
      resetConfigForTesting();
      
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `csv_confirm:${token}`,
        fromId: ADMIN_USER_ID,
      });
      await handleCsvConfirm(ctx);
      
      // Should deny with authorization message
      expect(ctx.answerCbQuery).toHaveBeenCalled();
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('No longer authorized'));
      
      // DB should be unchanged (no import happened)
      const afterSnapshot = JSON.stringify(['customers'].map(t => db.prepare('SELECT * FROM ' + t).all()));
      expect(afterSnapshot).toBe(beforeSnapshot);
    });
  });
});