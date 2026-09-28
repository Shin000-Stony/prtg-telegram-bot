import type { BotContext } from '@/integrations/telegram/bot';
import { statusService } from '@/modules/status/status.service';
import { accessService } from '@/modules/groups/access.service';
import { formatCustomerList, formatAccessDenied, formatWarning } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';
import type { StatusDetail } from '@/modules/status/status.types';
import { formatCustomerEntry } from '@/integrations/telegram/ui/messages';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

const logger = getLogger().child({ module: 'ClientsCommand' });

export async function clientsCommand(ctx: BotContext): Promise<void> {
  const context = {
    userId: ctx.userId || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'private',
  };

  if (!context.userId || !context.chatId) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  const scope = accessService.getCustomerAccessScope(context);
  if (scope.kind === 'none') {
    await ctx.reply(formatAccessDenied());
    return;
  }

  const details = statusService.getCustomerStatuses(context);

  if (details.length === 0) {
    await ctx.reply(formatWarning('No visible customers found'));
    return;
  }

  const chunks = chunkCustomerList(details);
  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: 'HTML' });
  }

  logger.info({ chatId: ctx.chatId, userId: ctx.userId, count: details.length }, 'Clients list sent');
}

function chunkCustomerList(details: StatusDetail[]): string[] {
  const full = formatCustomerList(details);
  if (full.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return [full];
  }

  const header = '📋 <b>Customers</b>\n\n';
  const footer = '\nView details: /client &lt;client_id&gt;';
  const maxContentLen = TELEGRAM_MAX_MESSAGE_LENGTH - header.length - footer.length;

  const chunks: string[] = [];
  let current = header;
  let currentLen = header.length;

  for (const detail of details) {
    const entry = formatCustomerEntry(detail);
    const entryWithSpacing = entry + '\n';

    if (currentLen + entryWithSpacing.length >= maxContentLen && currentLen > header.length) {
      chunks.push(current.trimEnd() + footer);
      current = header;
      currentLen = header.length;
    }

    current += entryWithSpacing;
    currentLen += entryWithSpacing.length;
  }

  chunks.push(current.trimEnd() + footer);
  return chunks;
}