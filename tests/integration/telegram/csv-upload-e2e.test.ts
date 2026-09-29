import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { handleCsvDocument, handleCsvConfirm } from '@/integrations/telegram/handlers/csv-import.handler';
import { csvUploadCommand, csvUploadCaption } from '@/integrations/telegram/commands/csv-upload.command';
import { accessService } from '@/modules/groups/access.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { pendingImportStore } from '@/modules/imports/pending-import.store';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const UTF8_BOM = '\uFEFF';
const ADMIN_USER_ID = '123456789';
const GLOBAL_GROUP_ID = '-1001234567890';

describe('CSV upload handler end-to-end: template -> upload -> confirm -> import', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-e2e-'));
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
    pendingImportStore.cleanup();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetConfigForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  function createUploadContext(fileContent: string, fileName = 'template.csv') {
    const buffer = Buffer.from(fileContent, 'utf-8');
    const fileUrl = `https://api.telegram.org/file/bot${'test_token'}/test`;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(fileContent),
    }));

    return {
      userId: ADMIN_USER_ID,
      chatId: GLOBAL_GROUP_ID,
      chatType: 'private',
      message: {
        document: {
          file_name: fileName,
          file_size: buffer.length,
          mime_type: 'text/csv',
          file_id: 'file123',
        },
      },
      telegram: {
        getFile: vi.fn().mockResolvedValue({ file_path: fileUrl }),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      replyWithDocument: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      answerCbQuery: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  it('full E2E: template BOM preserved -> upload -> preview (no writes) -> confirm -> 1 import', async () => {
    // Step 1: Generate template via csvUploadCommand
    vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
    const uploadCtx = {
      userId: ADMIN_USER_ID,
      chatId: GLOBAL_GROUP_ID,
      chatType: 'private',
      reply: vi.fn().mockResolvedValue(undefined),
      replyWithDocument: vi.fn().mockResolvedValue(undefined),
    } as any;

    await csvUploadCommand(uploadCtx);

    // Verify template was sent via replyWithDocument
    expect(uploadCtx.replyWithDocument).toHaveBeenCalledTimes(1);
    const docArg = uploadCtx.replyWithDocument.mock.calls[0][0];
    const captionArg = uploadCtx.replyWithDocument.mock.calls[0][1];
    expect(captionArg.caption).toBe(csvUploadCaption);
    expect(captionArg.parse_mode).toBe('HTML');

    // Extract the template buffer
    const templateBuffer = docArg.source as Buffer;
    const templateContent = templateBuffer.toString('utf-8');

    // Step 2: Verify template has BOM and correct headers
    expect(templateContent.startsWith(UTF8_BOM)).toBe(true);
    const headerLine = templateContent.split('\n')[0].replace(UTF8_BOM, '').trim();
    expect(headerLine).toBe('client_id,name,monitor_type,ping_host');

    // Step 3: Fill in one valid customer, preserving BOM
    const filledContent = templateContent + 'CUST-E2E-1,Test Customer E2E,icmp,10.0.0.42\r\n';

    // Step 4: Upload filled CSV via handleCsvDocument
    const uploadHandlerCtx = createUploadContext(filledContent);
    await handleCsvDocument(uploadHandlerCtx);

    // Verify preview message was sent (not document reply)
    expect(uploadHandlerCtx.reply).toHaveBeenCalledTimes(1);
    const previewMessage = uploadHandlerCtx.reply.mock.calls[0][0];
    expect(previewMessage).toContain('CSV IMPORT PREVIEW');
    expect(previewMessage).toContain('CUST-E2E-1');
    expect(previewMessage).toContain('Test Customer E2E');
    expect(previewMessage).toContain('ICMP');

    // Verify no customers written to DB yet (only on confirm)
    expect(customerRepository.count()).toBe(0);

    // Step 5: Extract token from the inline keyboard
    const replyOptions = uploadHandlerCtx.reply.mock.calls[0][1];
    const keyboard = replyOptions.reply_markup;
    const confirmButton = keyboard.inline_keyboard[0].find((b: { callback_data: string }) => b.callback_data.startsWith('csv_confirm:'));
    expect(confirmButton).toBeDefined();
    const token = confirmButton.callback_data.replace('csv_confirm:', '');

    // Step 6: Confirm import
    const confirmCtx = {
      userId: ADMIN_USER_ID,
      chatId: GLOBAL_GROUP_ID,
      chatType: 'private',
      callbackQuery: {
        data: `csv_confirm:${token}`,
        id: 'query1',
        from: { id: BigInt(ADMIN_USER_ID) },
      },
      answerCbQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleCsvConfirm(confirmCtx);

    // Verify answerCbQuery with importing
    expect(confirmCtx.answerCbQuery).toHaveBeenCalledWith('Importing...');

    // Verify editMessageText with import result (second call is the result)
    expect(confirmCtx.editMessageText).toHaveBeenCalledTimes(2);
    expect(confirmCtx.editMessageText).toHaveBeenNthCalledWith(1, '⏳ Importing customers...');
    expect(confirmCtx.editMessageText).toHaveBeenNthCalledWith(2, expect.stringContaining('Imported: 1'), { parse_mode: 'HTML' });
    const resultText = confirmCtx.editMessageText.mock.calls[1][0];
    expect(resultText).toContain('Imported: 1');

    // Verify exactly 1 customer in DB
    expect(customerRepository.count()).toBe(1);
    const imported = customerRepository.findByClientId('CUST-E2E-1');
    expect(imported).toBeDefined();
    expect(imported!.name).toBe('Test Customer E2E');
    expect(imported!.monitorType).toBe('icmp');
    expect(imported!.pingHost).toBe('10.0.0.42');
    expect(imported!.enabled).toBe(true);

    // Verify pending import was consumed
    expect(pendingImportStore.get(token)).toBeUndefined();
  });
});
