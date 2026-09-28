import type { BotContext } from '@/integrations/telegram/bot';
import { groupService } from '@/modules/groups/group.service';
import { accessService } from '@/modules/groups/access.service';
import { formatSuccess, formatError, formatInfo, formatAccessDenied } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'RegisterGroupCommand' });

export async function registerGroupCommand(ctx: BotContext): Promise<void> {
  if (!ctx.chatId || !ctx.chatType || !ctx.from) {
    return;
  }

  // Only allow in groups/supergroups
  if (!accessService.isGroupChat(ctx.chatType)) {
    await ctx.reply(formatError('This command only works in groups and supergroups'));
    return;
  }

  // Global Group does not need registration - check before admin
  if (accessService.isGlobalGroup(ctx.chatId)) {
    await ctx.reply(formatInfo('Global Group does not need registration. It has automatic access to all customers.'));
    return;
  }

  // Only allow for configured bot admins
  if (!accessService.isAdmin(ctx.from.id.toString())) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  if (!ctx.chat) {
    await ctx.reply(formatError('Group title not available'));
    return;
  }

  // Narrow chat type to GroupChat | SupergroupChat which have title
  const chat = ctx.chat as { title?: string };
  const title = chat.title || null;
  
  // Check if group already exists
  const existing = groupService.getByChatId(ctx.chatId);
  const group = groupService.register(ctx.chatId, title);

  if (existing) {
    await ctx.reply(
      formatInfo('Group is already registered')
    );
  } else {
    await ctx.reply(
      formatSuccess(`Group registered successfully\nChat ID: ${group.chatId}\nTitle: ${group.title || 'N/A'}`)
    );
    logger.info({ chatId: group.chatId, title: group.title }, 'Group registered');
  }
}