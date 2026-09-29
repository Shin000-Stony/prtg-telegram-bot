import type { BotContext } from '@/integrations/telegram/bot';
import { statusService } from '@/modules/status/status.service';
import { accessService } from '@/modules/groups/access.service';
import { clientsPaginationStore } from '@/modules/groups/clients-pagination.store';
import { formatCustomerListPage, formatCustomerSearchPage, formatAccessDenied, formatExpiredPagination, parsePositiveInteger } from '@/integrations/telegram/ui/messages';
import { createClientsPaginationKeyboard } from '@/integrations/telegram/ui/cards';
import { getLogger } from '@/core/logger';

const CLIENTS_PAGE_SIZE = 8;
const logger = getLogger().child({ module: 'ClientsCommand' });

export function extractClientsKeyword(text: string): string | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length <= 1) return null;
  const keyword = parts.slice(1).join(' ').trim();
  return keyword.length > 0 ? keyword : null;
}

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

  let keyword: string | null = null;
  let page = 1;

  if (ctx.message && 'text' in ctx.message) {
    const rawKeyword = extractClientsKeyword(ctx.message.text);
    if (rawKeyword && /^\d+$/.test(rawKeyword.trim())) {
      const pageNum = parseInt(rawKeyword.trim(), 10);
      if (!Number.isNaN(pageNum) && pageNum > 0) {
        page = pageNum;
        keyword = null;
      }
    } else if (rawKeyword) {
      keyword = rawKeyword;
    }
  }

  await renderClientsPage(ctx, context, keyword, page, undefined);
}

async function renderClientsPage(
  ctx: BotContext,
  context: { userId: string; chatId: string; chatType: string },
  keyword: string | null,
  page: number,
  editToken: string | undefined,
): Promise<void> {
  const allDetails = statusService.getCustomerStatusesWithFilter(context, keyword);

  if (allDetails.length === 0) {
    if (keyword) {
      if (editToken) {
        await ctx.editMessageText(formatCustomerSearchPage(keyword, [], 1, 0, 1)).catch(() => {});
      } else {
        await ctx.reply(formatCustomerSearchPage(keyword, [], 1, 0, 1), { parse_mode: 'HTML' });
      }
    } else {
      const scope = accessService.getCustomerAccessScope(context);
      if (scope.kind === 'none') {
        if (editToken) {
          await ctx.editMessageText(formatAccessDenied()).catch(() => {});
        } else {
          await ctx.reply(formatAccessDenied(), { parse_mode: 'HTML' });
        }
      } else {
        const emptyMsg = '<b>Customers</b>\n\nNo visible customers found.';
        if (editToken) {
          await ctx.editMessageText(emptyMsg, { parse_mode: 'HTML' }).catch(() => {});
        } else {
          await ctx.reply(emptyMsg, { parse_mode: 'HTML' });
        }
      }
    }
    logger.info({ chatId: context.chatId, userId: context.userId, keyword }, 'Clients list sent (empty)');
    return;
  }

  const total = allDetails.length;
  const totalPages = Math.max(1, Math.ceil(total / CLIENTS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * CLIENTS_PAGE_SIZE;
  const pageDetails = allDetails.slice(start, start + CLIENTS_PAGE_SIZE);

  let token: string;
  if (editToken) {
    token = editToken;
  } else {
    const session = clientsPaginationStore.create({
      userId: context.userId,
      chatId: context.chatId,
      messageId: null,
      keyword,
    });
    token = session.token;
  }

  const message = keyword
    ? formatCustomerSearchPage(keyword, pageDetails, safePage, total, totalPages)
    : formatCustomerListPage(pageDetails, safePage, total, totalPages);

  const keyboard = createClientsPaginationKeyboard(token, safePage, totalPages);

  if (editToken) {
    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }).catch(() => {});
  } else {
    const session = clientsPaginationStore.get(token);
    const result = await ctx.reply(message, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    const messageId = (result && typeof result === 'object' && 'message_id' in result)
      ? (result as { message_id: number }).message_id
      : null;
    if (session && messageId) {
      session.messageId = messageId;
    }
  }

  logger.info({ chatId: context.chatId, userId: context.userId, keyword, count: total, page: safePage, totalPages }, 'Clients list sent');
}

export async function handleClientsPagination(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const data = ctx.callbackQuery.data;
  if (typeof data !== 'string' || !data.startsWith('clients_page:')) {
    return;
  }

  const parts = data.slice('clients_page:'.length).split(':');
  if (parts.length !== 2) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const token = parts[0];
  const page = parsePositiveInteger(parts[1]);

  if (page === null) {
    await ctx.answerCbQuery('Invalid page');
    return;
  }

  await ctx.answerCbQuery();

  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'private',
  };

  if (!context.userId || !context.chatId) {
    await ctx.answerCbQuery('Invalid session');
    return;
  }

  const session = clientsPaginationStore.get(token);
  if (!session) {
    await ctx.answerCbQuery('Session expired');
    await ctx.editMessageText(formatExpiredPagination()).catch(() => {});
    return;
  }

  if (session.userId !== context.userId || session.chatId !== context.chatId) {
    await ctx.answerCbQuery('Unauthorized');
    return;
  }

  const messageId = ctx.callbackQuery.message && 'message_id' in ctx.callbackQuery.message
    ? (ctx.callbackQuery.message as { message_id: number }).message_id
    : null;

  if (session.messageId && messageId !== session.messageId) {
    await ctx.answerCbQuery('Session expired');
    return;
  }

  const scope = accessService.getCustomerAccessScope(context);
  if (scope.kind === 'none') {
    await ctx.answerCbQuery('Access denied');
    await ctx.editMessageText(formatAccessDenied()).catch(() => {});
    return;
  }

  await renderClientsPage(ctx, context, session.keyword, page, token);
}
