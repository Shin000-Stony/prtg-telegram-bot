import type { BotContext } from '@/integrations/telegram/bot';
import { groupService } from '@/modules/groups/group.service';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { groupAlertsStore, PAGE_SIZE } from '@/modules/groups/group-alerts.store';
import { createGroupAlertsKeyboard } from '@/integrations/telegram/ui/cards';
import {
  formatSuccess,
  formatError,
  formatAccessDenied,
  formatGroupAlertsMenuHeader,
  formatAlertCustomerLine,
  formatGroupAlertsEmpty,
} from '@/integrations/telegram/ui/messages';
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

  // Check group eligibility FIRST to avoid existence leakage
  if (!accessService.isGlobalGroup(ctx.chatId)) {
    if (!accessService.isGroupRegistered(ctx.chatId)) {
      await ctx.reply(formatError('This group is not registered. Run /register_group first.'));
      return;
    }
  }

  // Parse arguments
  if (!ctx.message || !('text' in ctx.message)) {
    return;
  }

  const parts = ctx.message.text.trim().split(/\s+/);

  // No arguments - show interactive menu
  if (parts.length <= 1) {
    await showAlertsMenu(ctx);
    return;
  }

  // Arguments provided - use existing on/off behavior
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

async function showAlertsMenu(ctx: BotContext): Promise<void> {
  const isGlobal = accessService.isGlobalGroup(ctx.chatId!);

  // For Global Group: include disabled customers
  // For ordinary groups: only assigned customers (with access rows)
  const customers = groupService.getGroupWithCustomerDetails(ctx.chatId!, isGlobal, !isGlobal);

  const session = groupAlertsStore.create({
    userId: ctx.from!.id.toString(),
    chatId: ctx.chatId!,
    messageId: null,
    isGlobalGroup: isGlobal,
    customers: customers.map((c) => ({
      customerId: c.customerId,
      clientId: c.clientId,
      name: c.name,
      monitorType: c.monitorType,
      canView: c.canView,
      enabled: c.enabled,
      receiveAlerts: c.receiveAlerts,
    })),
  });

  const total = session.customers.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, session.currentPage), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const pageCustomers = session.customers.slice(start, start + PAGE_SIZE);

  const groupType = isGlobal ? 'global' : 'ordinary';

  if (total === 0) {
    await ctx.reply(formatGroupAlertsEmpty(groupType), { parse_mode: 'HTML' });
    groupAlertsStore.delete(session.token);
    return;
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
    pageCustomers.map((c) => ({
      customerId: c.customerId,
      clientId: c.clientId,
      name: c.name,
      canView: c.canView,
      enabled: c.enabled,
      receiveAlerts: c.receiveAlerts,
    })),
    safePage,
    totalPages,
    PAGE_SIZE
  );

  const result = await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });

  const messageId = (result && typeof result === 'object' && 'message_id' in result)
    ? (result as { message_id: number }).message_id
    : null;
  if (messageId) {
    session.messageId = messageId;
  }

  logger.info({ chatId: ctx.chatId, userId: ctx.from?.id.toString(), customerCount: total, isGlobal }, 'Group alerts menu opened');
}
