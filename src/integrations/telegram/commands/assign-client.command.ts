import type { BotContext } from '@/integrations/telegram/bot';
import { groupService } from '@/modules/groups/group.service';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { formatSuccess, formatError, formatAccessDenied, formatInfo } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'AssignClientCommand' });

export async function assignClientCommand(ctx: BotContext): Promise<void> {
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

  // Global Group - assignment not needed
  if (accessService.isGlobalGroup(ctx.chatId)) {
    await ctx.reply(
      formatInfo('Global Group has automatic access to all customers. Assignment is not required.')
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
    await ctx.reply(formatError('Usage: /assign_client <client_id>'));
    return;
  }

  const clientId = parts[1].trim();
  const customer = customerService.getByClientId(clientId);

  if (!customer) {
    await ctx.reply(formatError('Customer not found'));
    return;
  }

  // Assign customer to group
  const access = groupService.assignCustomer({
    groupChatId: ctx.chatId,
    customerId: customer.id,
    canView: true,
    receiveAlerts: false,
  });

  await ctx.reply(
    formatSuccess(
      `Customer assigned to group\n` +
      `Client ID: ${customer.clientId}\n` +
      `Name: ${customer.name}\n` +
      `Visibility: Enabled\n` +
      `Alerts: ${access.receiveAlerts ? 'ON' : 'OFF'} (use /group_alerts ${customer.clientId} on to enable)`
    )
  );
  logger.info({ chatId: ctx.chatId, userId: ctx.from?.id.toString(), clientId }, 'Customer assigned to group');
}