import type { BotContext } from '@/integrations/telegram/bot';
import { csvImportService } from '@/modules/imports/csv-import.service';
import { pendingImportStore } from '@/modules/imports/pending-import.store';
import { accessService } from '@/modules/groups/access.service';
import { getConfig } from '@/config/env';
import { CSV_MAX_FILE_BYTES } from '@/modules/imports/csv-import.types';
import { formatCsvPreview, formatAccessDenied } from '@/integrations/telegram/ui/messages';
import { createCsvConfirmKeyboard, parseCsvCallback } from '@/integrations/telegram/ui/cards';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'CsvImportHandler' });

export async function handleCsvDocument(ctx: BotContext): Promise<void> {
  const config = getConfig();

  if (!ctx.message || !('document' in ctx.message)) {
    return;
  }

  const document = ctx.message.document;
  const fileName = document.file_name || '';
  const fileSize = document.file_size || 0;

  if (!ctx.chatId || !ctx.userId) {
    return;
  }

  const context = {
    userId: ctx.userId,
    chatId: ctx.chatId,
    chatType: ctx.chatType || 'private',
  };

  if (!accessService.canManageCustomers(context)) {
    await ctx.reply(formatAccessDenied('CSV import requires admin privileges in private chat or global group'));
    return;
  }

  if (!fileName.toLowerCase().endsWith('.csv')) {
    await ctx.reply('❌ Please upload a .csv file');
    return;
  }

  if (fileSize > CSV_MAX_FILE_BYTES) {
    await ctx.reply(`❌ File too large. Maximum size: ${CSV_MAX_FILE_BYTES / 1024 / 1024} MiB`);
    return;
  }

  if (fileSize === 0) {
    await ctx.reply('❌ Empty file');
    return;
  }

  try {
    const file = await ctx.telegram.getFile(document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }
    const content = await response.text();

    if (!content.trim()) {
      await ctx.reply('❌ Empty file content');
      return;
    }

    const { result, summary, rowsToImport } = csvImportService.validateAndSummarize(content);

    if (summary.validCount === 0) {
      await ctx.reply(formatCsvPreview(fileName, summary, result.errors, []));
      return;
    }

    const pending = pendingImportStore.create(ctx.chatId, ctx.userId, rowsToImport, summary);

    await ctx.reply(
      formatCsvPreview(fileName, summary, result.errors, rowsToImport.slice(0, 5)),
      { parse_mode: 'HTML', reply_markup: createCsvConfirmKeyboard(pending.id) }
    );

    logger.info({ pendingId: pending.id, chatId: ctx.chatId, userId: ctx.userId, summary }, 'CSV preview created');
  } catch (error) {
    logger.error({ err: error }, 'CSV document handling failed');
    await ctx.reply('❌ Failed to process CSV file');
  }
}

export async function handleCsvConfirm(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseCsvCallback(ctx.callbackQuery.data);
  if (!parsed || parsed.action !== 'csv_confirm') {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const pending = pendingImportStore.get(parsed.token);
  if (!pending) {
    await ctx.answerCbQuery('Import session expired or invalid');
    await ctx.editMessageText('❌ Import session expired or invalid').catch(() => {});
    return;
  }

  if (pending.chatId !== ctx.chatId) {
    await ctx.answerCbQuery('This import belongs to a different chat');
    return;
  }

  if (pending.userId !== ctx.userId) {
    await ctx.answerCbQuery('Only the original uploader can confirm');
    return;
  }

  const context = {
    userId: ctx.userId!,
    chatId: ctx.chatId!,
    chatType: ctx.chatType || 'private',
  };
  if (!accessService.canManageCustomers(context)) {
    await ctx.answerCbQuery('No longer authorized');
    await ctx.editMessageText('❌ No longer authorized to confirm').catch(() => {});
    return;
  }

  const consumed = pendingImportStore.consume(parsed.token);
  if (!consumed) {
    await ctx.answerCbQuery('Import already processed');
    return;
  }

  await ctx.answerCbQuery('Importing...');
  await ctx.editMessageText('⏳ Importing customers...').catch(() => {});

  try {
    const importResult = await csvImportService.import(consumed.rows);
    await ctx.editMessageText(
      `✅ Import completed\nImported: ${importResult.imported}\nSkipped: ${importResult.skipped}\nErrors: ${importResult.errors.length}`,
      { parse_mode: 'HTML' }
    );
    logger.info({ pendingId: parsed.token, result: importResult }, 'CSV import confirmed and executed');
  } catch (error) {
    logger.error({ err: error, pendingId: parsed.token }, 'CSV import execution failed');
    await ctx.editMessageText('❌ Import failed. See logs for details.').catch(() => {});
  }
}

export async function handleCsvCancel(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseCsvCallback(ctx.callbackQuery.data);
  if (!parsed || parsed.action !== 'csv_cancel') {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const pending = pendingImportStore.get(parsed.token);
  if (!pending) {
    await ctx.answerCbQuery('Import session expired or invalid');
    await ctx.editMessageText('❌ Import session expired').catch(() => {});
    return;
  }

  if (pending.chatId !== ctx.chatId) {
    await ctx.answerCbQuery('This import belongs to a different chat');
    return;
  }

  if (pending.userId !== ctx.userId) {
    await ctx.answerCbQuery('Only the original uploader can cancel');
    return;
  }

  pendingImportStore.delete(parsed.token);
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Import cancelled').catch(() => {});
  logger.info({ pendingId: parsed.token }, 'CSV import cancelled by user');
}