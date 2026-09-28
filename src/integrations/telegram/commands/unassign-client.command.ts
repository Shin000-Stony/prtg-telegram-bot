import type { BotContext } from '@/integrations/telegram/bot';
import { groupService } from '@/modules/groups/group.service';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { formatSuccess, formatError, formatAccessDenied, formatInfo } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'UnassignClientCommand' });

export async function unassignClientCommand(ctx: BotContext): Promise<void> {
  if (!ctx.chatId || !ctx.chatType || !ctx.from) {
    return;
  }

  // Only allow in groups
  if (!accessService.isGroupChat(ctx.chatType)) {
    await ctx.reply(formatError('This command only works in groups'));
    return;
  }

  // Only allow for configured bot admins
  if (!accessService.isAdmin(ctx.from.id.toString())) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  // Global Group - informational response
  if (accessService.isGlobalGroup(ctx.chatId)) {
    await ctx.reply(
      formatInfo('Global Group cannot hide customers. Use /group_alerts <client_id> off to disable alerts for specific customers.')
    );
    return;
  }

  // Check if group is registered
  if (!accessService.isGroupRegistered(ctx.chatId)) {
    await ctx.reply(
      formatError('This group is not registered. Run /register_group first.')
    );
    return;
  }

  // Parse client_id from command
  if (!ctx.message || !('text' in ctx.message)) {
    return;
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply(formatError('Usage: /unassign_client <client_id>'));
    return;
  }

  const clientId = parts[1].trim();
  const customer = customerService.getByClientId(clientId);

  if (!customer) {
    await ctx.reply(formatError('Customer not found'));
    return;
  }

  // Unassign customer from group
  const result = groupService.unassignCustomer(ctx.chatId, customer.id);

  let message = `Customer unassigned from group\nClient ID: ${customer.clientId}\nName: ${customer.name}`;

  if (result.receiveAlerts) {
    message += '\n\nClient is hidden. Alert subscription remains ON.';
    message += '\nUse /group_alerts ' + customer.clientId + ' off to disable alerts.';
  }

  await ctx.reply(formatSuccess(message));
  logger.info({ chatId: ctx.chatId, userId: ctx.from?.id.toString(), clientId }, 'Customer unassigned from group');
}