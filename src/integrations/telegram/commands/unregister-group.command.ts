import type { BotContext } from '@/integrations/telegram/bot';
import { groupService } from '@/modules/groups/group.service';
import { accessService } from '@/modules/groups/access.service';
import { pendingUnregisterStore } from '@/modules/groups/pending-unregister.store';
import { formatError, formatWarning, formatAccessDenied, formatInfo } from '@/integrations/telegram/ui/messages';
import { createUnregisterConfirmKeyboard } from '@/integrations/telegram/ui/cards';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'UnregisterGroupCommand' });

export async function unregisterGroupCommand(ctx: BotContext): Promise<void> {
  if (!ctx.chatId || !ctx.chatType || !ctx.from) {
    return;
  }

  // Only allow in groups/supergroups
  if (!accessService.isGroupChat(ctx.chatType)) {
    await ctx.reply(formatError('This command only works in groups and supergroups'));
    return;
  }

  // Only allow for configured bot admins
  if (!accessService.isAdmin(ctx.from.id.toString())) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  // Global Group cannot be unregistered through this command
  if (accessService.isGlobalGroup(ctx.chatId)) {
    await ctx.reply(formatInfo('Global Group cannot be unregistered. It is configured via TELEGRAM_GLOBAL_GROUP_ID.'));
    return;
  }

  // Check if group is registered
  const group = groupService.getByChatId(ctx.chatId);
  if (!group || !group.enabled) {
    await ctx.reply(formatInfo('This group is not registered.'));
    return;
  }

  // Create pending unregister
  const pending = pendingUnregisterStore.create(ctx.chatId, ctx.from.id.toString());

  await ctx.reply(
    formatWarning(
      `UNREGISTER GROUP\n\n` +
      `Chat ID: ${group.chatId}\n` +
      `Title: ${group.title || 'N/A'}\n\n` +
      `This will remove the group registration and all customer assignments.\n` +
      `Alert subscriptions will be removed.\n\n` +
      `Are you sure?`
    ),
    { parse_mode: 'HTML', reply_markup: createUnregisterConfirmKeyboard(pending.id) }
  );

  logger.info({ chatId: group.chatId, pendingId: pending.id }, 'Unregister confirmation requested');
}