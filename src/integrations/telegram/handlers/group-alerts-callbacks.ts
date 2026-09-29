import type { BotContext } from '@/integrations/telegram/bot';
import { accessService } from '@/modules/groups/access.service';
import { groupService } from '@/modules/groups/group.service';
import { groupAlertsStore, PAGE_SIZE, type GroupAlertsSession } from '@/modules/groups/group-alerts.store';
import { parseGroupAlertsCallback, createGroupAlertsKeyboard, createGroupAlertsBulkConfirmKeyboard } from '@/integrations/telegram/ui/cards';
import {
  formatGroupAlertsMenuHeader,
  formatAlertCustomerLine,
  formatGroupAlertsEmpty,
  formatGroupAlertsBulkPreview,
  formatGroupAlertsBulkResult,
  formatGroupAlertsToggleResult,
  formatGroupAlertsClosed,
  formatError,
  SEPARATOR,
} from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';
import type { InlineKeyboardMarkup } from 'telegraf/types';

const logger = getLogger().child({ module: 'GroupAlertsCallbacks' });

function isAuthorizedForGroupContext(userId: string, chatId: string, chatType: string): boolean {
  if (!accessService.isAdmin(userId)) {
    return false;
  }
  if (accessService.isGlobalGroup(chatId)) {
    return true;
  }
  if (!accessService.isGroupChat(chatType)) {
    return false;
  }
  return accessService.isGroupRegistered(chatId);
}

function validateSessionOwnership(session: GroupAlertsSession, ctx: BotContext): string | null {
  if (session.userId !== ctx.userId) {
    return 'Unauthorized: this menu belongs to another user';
  }
  if (session.chatId !== ctx.chatId) {
    return 'This menu belongs to a different chat';
  }
  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || '',
  };
  if (!isAuthorizedForGroupContext(context.userId, context.chatId, context.chatType)) {
    return 'Admin access required in this group';
  }
  if (session.messageId === null) {
    return 'Session message ID missing';
  }
  if (ctx.callbackQuery?.message?.message_id !== session.messageId) {
    return 'Session message changed';
  }
  return null;
}

function validateSessionToken(parsed: { token: string }, ctx: BotContext): GroupAlertsSession | string {
  const session = groupAlertsStore.get(parsed.token);
  if (!session) {
    return 'Session expired. Run /group_alerts again.';
  }
  const ownershipError = validateSessionOwnership(session, ctx);
  if (ownershipError) {
    return ownershipError;
  }
  return session;
}

function refreshCustomers(session: GroupAlertsSession): void {
  session.customers = groupService.getGroupWithCustomerDetails(session.chatId, session.isGlobalGroup, true);
}

function buildMenuMessage(session: GroupAlertsSession): { text: string; keyboard: InlineKeyboardMarkup } {
  const allCustomers = session.customers;
  const total = allCustomers.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, session.currentPage), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const pageCustomers = allCustomers.slice(start, start + PAGE_SIZE);

  const groupType = session.isGlobalGroup ? 'global' : 'ordinary';

  if (total === 0) {
    return {
      text: formatGroupAlertsEmpty(groupType),
      keyboard: {
        inline_keyboard: [
          [{ text: '❌ Close', callback_data: `alerts_close:${session.token}` }],
        ],
      },
    };
  }

  const header = formatGroupAlertsMenuHeader(groupType, total, safePage, totalPages);

  const lines: string[] = [header];
  for (let i = 0; i < pageCustomers.length; i++) {
    if (i > 0) {
      lines.push('');
    }
    lines.push(formatAlertCustomerLine(pageCustomers[i]));
  }

  const keyboard = createGroupAlertsKeyboard(
    session.token,
    pageCustomers,
    safePage,
    totalPages,
    PAGE_SIZE
  );

  return { text: lines.join('\n'), keyboard };
}

async function editMenu(ctx: BotContext, session: GroupAlertsSession): Promise<void> {
  refreshCustomers(session);
  const message = buildMenuMessage(session);
  await ctx.editMessageText(message.text, {
    parse_mode: 'HTML',
    reply_markup: message.keyboard,
  }).catch((error: Error) => {
    if (!error.message.includes('message is not modified')) {
      logger.error({ err: error, token: session.token }, 'Failed to render menu');
    }
  });
}

function isExecuting(session: GroupAlertsSession): boolean {
  return session.state === 'executing';
}

export async function handleGroupAlertsToggle(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseGroupAlertsCallback(ctx.callbackQuery.data as string);
  if (!parsed || parsed.action !== 'alerts_toggle' || parsed.customerId === undefined || !parsed.toggleTarget) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const result = validateSessionToken(parsed, ctx);
  if (typeof result === 'string') {
    await ctx.answerCbQuery(result);
    return;
  }
  const session = result;

  if (isExecuting(session)) {
    await ctx.answerCbQuery('A bulk operation is in progress; finish it first');
    return;
  }

  const targetOn = parsed.toggleTarget === 'on';

  refreshCustomers(session);
  const customer = session.customers.find((c) => c.customerId === parsed.customerId);
  if (!customer || !customer.canView) {
    await ctx.answerCbQuery('Customer not in this view or visibility revoked');
    return;
  }

  try {
    groupService.setAlertSubscription(ctx.chatId!, customer.customerId, targetOn);

    await ctx.answerCbQuery(formatGroupAlertsToggleResult(
      { clientId: customer.clientId, name: customer.name },
      targetOn
    ));

    await editMenu(ctx, session);

    logger.info({ customerId: customer.customerId, chatId: session.chatId, receiveAlerts: targetOn }, 'Alert subscription toggled');
  } catch (error) {
    logger.error({ err: error, customerId: customer.customerId }, 'Failed to toggle alert subscription');
    await ctx.answerCbQuery('Failed to update alert subscription');
  }
}

export async function handleGroupAlertsPage(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseGroupAlertsCallback(ctx.callbackQuery.data as string);
  if (!parsed || parsed.action !== 'alerts_page' || parsed.page === undefined) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const result = validateSessionToken(parsed, ctx);
  if (typeof result === 'string') {
    await ctx.answerCbQuery(result);
    return;
  }
  const session = result;

  if (isExecuting(session)) {
    await ctx.answerCbQuery('A bulk operation is in progress; finish it first');
    return;
  }

  refreshCustomers(session);
  const total = session.customers.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  session.currentPage = Math.min(Math.max(1, parsed.page), totalPages);

  await ctx.answerCbQuery();
  await editMenu(ctx, session);
}

export async function handleGroupAlertsBulk(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseGroupAlertsCallback(ctx.callbackQuery.data as string);
  if (!parsed || parsed.action !== 'alerts_bulk' || !parsed.bulkAction) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const bulkAction = parsed.bulkAction;
  if (bulkAction !== 'enable_all' && bulkAction !== 'disable_all') {
    await ctx.answerCbQuery('Invalid bulk action');
    return;
  }

  const result = validateSessionToken(parsed, ctx);
  if (typeof result === 'string') {
    await ctx.answerCbQuery(result);
    return;
  }
  const session = result;

  if (isExecuting(session)) {
    await ctx.answerCbQuery('A bulk operation is in progress; finish it first');
    return;
  }

  const previewId = groupAlertsStore.generatePreviewId();

  session.state = 'pending';
  session.currentPreview = {
    previewId,
    action: bulkAction,
    targetIds: [],
    affectedIds: [],
    createdAt: new Date(),
  };

  try {
    refreshCustomers(session);

    const targetOn = bulkAction === 'enable_all';
    session.currentPreview!.targetIds = session.customers.map((c) => c.customerId);
    session.currentPreview!.affectedIds = session.customers
      .filter((c) => c.receiveAlerts !== targetOn)
      .map((c) => c.customerId);

    if (session.currentPreview!.affectedIds.length === 0) {
      const verb = bulkAction === 'enable_all' ? 'already ON' : 'already OFF';
      session.state = 'idle';
      session.currentPreview = null;
      await ctx.answerCbQuery(`All alerts are ${verb}`);
      return;
    }

    const previewText = formatGroupAlertsBulkPreview(
      bulkAction,
      session.customers
        .filter((c) => session.currentPreview!.affectedIds.includes(c.customerId))
        .map((c) => ({
          clientId: c.clientId,
          name: c.name,
          receiveAlerts: c.receiveAlerts,
          enabled: c.enabled,
        })),
      session.isGlobalGroup
    );

    await ctx.editMessageText(previewText, {
      parse_mode: 'HTML',
      reply_markup: createGroupAlertsBulkConfirmKeyboard(session.token, previewId),
    });

    logger.info(
      { token: session.token, previewId, action: bulkAction, affected: session.currentPreview!.affectedIds.length, userId: ctx.userId },
      'Bulk alert preview shown'
    );
  } catch (error) {
    logger.error({ err: error, token: session.token }, 'Failed to show bulk preview');
    session.state = 'idle';
    session.currentPreview = null;
    await ctx.answerCbQuery('Failed to prepare bulk action').catch(() => {});
  }
}

export async function handleGroupAlertsBulkConfirm(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseGroupAlertsCallback(ctx.callbackQuery.data as string);
  if (!parsed || parsed.action !== 'ga_confirm' || !parsed.previewId) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const result = validateSessionToken(parsed, ctx);
  if (typeof result === 'string') {
    await ctx.answerCbQuery(result);
    return;
  }
  const session = result;

  const preview = session.currentPreview;
  if (!preview || preview.previewId !== parsed.previewId || session.state !== 'pending') {
    await ctx.answerCbQuery('Preview expired or invalid');
    return;
  }

  session.state = 'executing';
  const action = preview.action;
  const targetIds = [...preview.targetIds];

  let updated: number;
  try {
    const targetOn = action === 'enable_all';
    updated = groupService.bulkSetAlertSubscription(session.chatId, targetIds, targetOn);
  } catch (error) {
    logger.error({ err: error, action }, 'Bulk alert transaction failed');
    session.state = 'idle';
    session.currentPreview = null;
    refreshCustomers(session);
    await ctx.answerCbQuery('Bulk action failed; see logs for details').catch(() => {});
    await editMenu(ctx, session);
    return;
  }

  session.currentPreview = null;

  try {
    await ctx.answerCbQuery().catch(() => {});

    refreshCustomers(session);
    const menuMessage = buildMenuMessage(session);
    const combinedText = `${formatGroupAlertsBulkResult(action, updated)}\n\n${SEPARATOR}\n\n${menuMessage.text}`;
    await ctx.editMessageText(combinedText, {
      parse_mode: 'HTML',
      reply_markup: menuMessage.keyboard,
    }).catch(() => {
      logger.error({ token: session.token }, 'Failed to edit message with bulk result and menu');
    });

    logger.info({ token: session.token, action, updated, userId: ctx.userId }, 'Bulk alert action completed');
  } catch (uiError) {
    logger.error({ err: uiError, token: session.token }, 'UI response failed after successful DB commit');
  } finally {
    session.state = 'idle';
  }
}

export async function handleGroupAlertsBulkCancel(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseGroupAlertsCallback(ctx.callbackQuery.data as string);
  if (!parsed || parsed.action !== 'ga_cancel' || !parsed.previewId) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const result = validateSessionToken(parsed, ctx);
  if (typeof result === 'string') {
    await ctx.answerCbQuery(result);
    return;
  }
  const session = result;

  if (session.state !== 'pending') {
    await ctx.answerCbQuery('No pending bulk action to cancel');
    return;
  }

  const preview = session.currentPreview;
  if (!preview || preview.previewId !== parsed.previewId) {
    await ctx.answerCbQuery('Preview expired or invalid');
    return;
  }

  session.state = 'idle';
  session.currentPreview = null;

  await ctx.answerCbQuery('Cancelled');
  await editMenu(ctx, session);
  logger.info({ token: session.token, previewId: parsed.previewId, userId: ctx.userId }, 'Bulk alert action cancelled');
}

export async function handleGroupAlertsClose(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseGroupAlertsCallback(ctx.callbackQuery.data as string);
  if (!parsed || parsed.action !== 'close') {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const result = validateSessionToken(parsed, ctx);
  if (typeof result === 'string') {
    await ctx.answerCbQuery(result);
    return;
  }
  const session = result;

  if (isExecuting(session)) {
    await ctx.answerCbQuery('A bulk operation is in progress; finish it first');
    return;
  }

  groupAlertsStore.delete(parsed.token);
  await ctx.answerCbQuery('Closed');
  await ctx.editMessageText(formatGroupAlertsClosed()).catch(() => {});
  logger.info({ token: parsed.token, userId: ctx.userId }, 'Group alerts menu closed');
}
