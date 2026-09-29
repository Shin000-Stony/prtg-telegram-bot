import type { BotContext } from '@/integrations/telegram/bot';
import { accessService } from '@/modules/groups/access.service';
import { ALL_HEADERS, REQUIRED_HEADERS, OPTIONAL_HEADERS } from '@/modules/imports/csv-import.types';
import { MONITOR_TYPES } from '@/config/constants';
import { formatAccessDenied } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'CsvUploadCommand' });

const UTF8_BOM = '\uFEFF';

function generateTemplateCsv(): string {
  const header = UTF8_BOM + ALL_HEADERS.join(',') + '\r\n';
  return header;
}

export const csvUploadCaption = [
  '📄 <b>Customer Import Template</b>',
  '',
  '1. Download this CSV template file',
  '2. Fill in your customers (keep the header row)',
  '3. Upload the .csv back to this chat',
  '',
  '<b>Required columns:</b> ' + REQUIRED_HEADERS.join(', '),
  '<b>Optional columns:</b> ' + OPTIONAL_HEADERS.join(', '),
  '<b>Allowed monitor_type values:</b> ' + MONITOR_TYPES.join(', '),
  '',
  '⚠️ <b>Save as CSV, not XLSX</b> — Excel may add a BOM or change formatting',
  '⚠️ Max file size: 1 MiB',
].join('\n');

export async function csvUploadCommand(ctx: BotContext): Promise<void> {
  const context = {
    userId: ctx.userId || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'private',
  };

  if (!context.userId || !context.chatId) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  if (!accessService.canManageCustomers(context)) {
    await ctx.reply(
      formatAccessDenied('CSV upload requires admin privileges in private chat or global group'),
    );
    return;
  }

  try {
    const csvContent = generateTemplateCsv();
    const buffer = Buffer.from(csvContent, 'utf-8');

    await ctx.replyWithDocument(
       {
        source: buffer,
        filename: 'customer_import_template.csv',
      },
      {
        caption: csvUploadCaption,
        parse_mode: 'HTML',
      },
    );

    logger.info({ chatId: ctx.chatId, userId: ctx.userId }, 'CSV template sent');
  } catch (error) {
    logger.error({ err: error }, 'Failed to send CSV template');
    await ctx.reply('❌ Failed to generate template. Please try again.');
  }
}
