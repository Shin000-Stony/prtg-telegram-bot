import type { BotContext } from '@/integrations/telegram/bot';
import { groupService } from '@/modules/groups/group.service';
import { accessService } from '@/modules/groups/access.service';
import { pendingUnregisterStore } from '@/modules/groups/pending-unregister.store';
import { parseUnregisterCallback } from '@/integrations/telegram/ui/cards';
import { getConfig } from '@/config/env';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'UnregisterCallbackHandler' });

export async function handleUnregisterConfirm(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseUnregisterCallback(ctx.callbackQuery.data);
  if (!parsed || parsed.action !== 'confirm') {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const pending = pendingUnregisterStore.get(parsed.token);
  if (!pending) {
    await ctx.answerCbQuery('Unregister session expired or invalid');
    await ctx.editMessageText('❌ Unregister session expired or invalid').catch(() => {});
    return;
  }

  const config = getConfig();
  const isGlobalGroup = config.TELEGRAM_GLOBAL_GROUP_ID && pending.chatId === config.TELEGRAM_GLOBAL_GROUP_ID;
  if (isGlobalGroup) {
    await ctx.answerCbQuery('Unregister session expired or invalid');
    await ctx.editMessageText('❌ Unregister session expired or invalid').catch(() => {});
    return;
  }

  if (pending.chatId !== ctx.chatId) {
    await ctx.answerCbQuery('This unregister belongs to a different chat');
    return;
  }

  if (pending.userId !== ctx.from?.id.toString()) {
    await ctx.answerCbQuery('Only the original requester can confirm');
    return;
  }

  // Check current authorization
  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'group',
  };
  if (!accessService.canUnregisterGroup(context)) {
    await ctx.answerCbQuery('No longer authorized to unregister this group');
    await ctx.editMessageText('❌ No longer authorized to unregister this group').catch(() => {});
    return;
  }

  const consumed = pendingUnregisterStore.consume(parsed.token);
  if (!consumed) {
    await ctx.answerCbQuery('Unregister already processed');
    return;
  }

  await ctx.answerCbQuery('Unregistering...');
  await ctx.editMessageText('⏳ Unregistering group...').catch(() => {});

  try {
    const success = groupService.unregisterGroup(pending.chatId);
    if (success) {
      await ctx.editMessageText(
        '✅ Group unregistered successfully',
        { parse_mode: 'HTML' }
      );
      logger.info({ pendingId: parsed.token }, 'Group unregistered via callback');
    } else {
      await ctx.editMessageText('❌ Group was not registered or already unregistered').catch(() => {});
    }
  } catch (error) {
    logger.error({ err: error, pendingId: parsed.token }, 'Unregister failed');
    await ctx.editMessageText('❌ Unregister failed. See logs for details.').catch(() => {});
  }
}

export async function handleUnregisterCancel(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseUnregisterCallback(ctx.callbackQuery.data);
  if (!parsed || parsed.action !== 'cancel') {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const pending = pendingUnregisterStore.get(parsed.token);
  if (!pending) {
    await ctx.answerCbQuery('Unregister session expired or invalid');
    await ctx.editMessageText('❌ Unregister session expired').catch(() => {});
    return;
  }

  if (pending.chatId !== ctx.chatId) {
    await ctx.answerCbQuery('This unregister belongs to a different chat');
    return;
  }

  if (pending.userId !== ctx.from?.id.toString()) {
    await ctx.answerCbQuery('Only the original requester can cancel');
    return;
  }

  pendingUnregisterStore.delete(parsed.token);
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Unregister cancelled').catch(() => {});
  logger.info({ pendingId: parsed.token }, 'Unregister cancelled by user');
}