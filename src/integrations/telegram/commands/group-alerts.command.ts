import type { BotContext } from '@/integrations/telegram/bot';
import { groupService } from '@/modules/groups/group.service';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { formatSuccess, formatError, formatAccessDenied } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'GroupAlertsCommand' });

export async function groupAlertsCommand(ctx: BotContext): Promise<void> {
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

  // Parse arguments
  if (!ctx.message || !('text' in ctx.message)) {
    return;
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 3) {
    await ctx.reply(formatError('Usage: /group_alerts <client_id> on|off'));
    return;
  }

  const clientId = parts[1].trim();
  const action = parts[2].trim().toLowerCase();

  if (action !== 'on' && action !== 'off') {
    await ctx.reply(formatError('Action must be "on" or "off"'));
    return;
  }

  const receiveAlerts = action === 'on';

  // Check group eligibility FIRST to avoid existence leakage
  if (!accessService.isGlobalGroup(ctx.chatId)) {
    if (!accessService.isGroupRegistered(ctx.chatId)) {
      await ctx.reply(formatError('This group is not registered. Run /register_group first.'));
      return;
    }
  }

  // Now look up customer
  const customer = customerService.getByClientId(clientId);
  if (!customer) {
    await ctx.reply(formatError('Customer not found'));
    return;
  }

  // Global Group - can enable alerts for any customer
  if (accessService.isGlobalGroup(ctx.chatId)) {
    const access = groupService.setAlertSubscription(ctx.chatId, customer.id, receiveAlerts);

    await ctx.reply(
      formatSuccess(
        `Alert subscription ${receiveAlerts ? 'enabled' : 'disabled'} for Global Group\n` +
        `Client ID: ${customer.clientId}\n` +
        `Name: ${customer.name}\n` +
        `Alerts: ${access.receiveAlerts ? 'ON' : 'OFF'}`
      )
    );
    logger.info({ chatId: ctx.chatId, userId: ctx.from?.id.toString(), clientId, receiveAlerts }, 'Global Group alert subscription updated');
    return;
  }

  // Ordinary registered group
  const updatedAccess = groupService.setAlertSubscription(ctx.chatId, customer.id, receiveAlerts);

  await ctx.reply(
    formatSuccess(
      `Alert subscription ${receiveAlerts ? 'enabled' : 'disabled'} for group\n` +
      `Client ID: ${customer.clientId}\n` +
      `Name: ${customer.name}\n` +
      `Visibility: ${updatedAccess.canView ? 'Visible' : 'Hidden'}\n` +
      `Alerts: ${updatedAccess.receiveAlerts ? 'ON' : 'OFF'}`
    )
  );
  logger.info({ chatId: ctx.chatId, userId: ctx.from?.id.toString(), clientId, receiveAlerts }, 'Group alert subscription updated');
}