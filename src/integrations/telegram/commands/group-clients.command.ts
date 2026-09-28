import type { BotContext } from '@/integrations/telegram/bot';
import { groupService } from '@/modules/groups/group.service';
import { accessService } from '@/modules/groups/access.service';
import { formatError, formatWarning, formatInfo } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'GroupClientsCommand' });

export async function groupClientsCommand(ctx: BotContext): Promise<void> {
  if (!ctx.chatId || !ctx.chatType || !ctx.from) {
    return;
  }

  const context = {
    userId: ctx.from.id.toString(),
    chatId: ctx.chatId,
    chatType: ctx.chatType,
  };

  // Private chat - must be admin and explain group context
  if (accessService.isPrivateChat(ctx.chatType)) {
    if (!accessService.isAdmin(context.userId)) {
      await ctx.reply(formatError('This command must be run in a group'));
      return;
    }
    await ctx.reply(
      formatInfo('This command must be run inside a group. Add the bot to a group and run /group_clients there.')
    );
    return;
  }

  // Global Group - shows all customers
  if (accessService.isGlobalGroup(ctx.chatId)) {
    // Admin in global group - no scope check needed, show all
    const customers = groupService.getGroupWithCustomerDetails(ctx.chatId);

    if (customers.length === 0) {
      await ctx.reply('No customers found in Global Group');
      return;
    }

    const lines = ['👥 <b>GLOBAL GROUP CLIENTS</b>', ''];
    for (const c of customers) {
      const visibility = c.canView ? '👁 Visible' : '🚫 Hidden';
      const alerts = c.receiveAlerts ? '🔔 Alerts ON' : '🔕 Alerts OFF';
      lines.push(`#${c.clientId} ${c.name}`);
      lines.push(`  ${visibility} | ${alerts}`);
      lines.push('');
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    return;
  }

  // Registered ordinary group
  if (!accessService.isGroupRegistered(ctx.chatId)) {
    const isAdmin = accessService.isAdmin(context.userId);
    if (isAdmin) {
      await ctx.reply(
        formatWarning(
          'This group is not registered.\n' +
          'Run /register_group to register this group.'
        )
      );
    } else {
      await ctx.reply(formatError('This group is not registered. Ask an admin to run /register_group.'));
    }
    return;
  }

  // Registered ordinary group - show assigned customers
  const scope = accessService.getCustomerAccessScope({
    userId: context.userId,
    chatId: ctx.chatId,
    chatType: ctx.chatType,
  });

  let customers: Array<{ customerId: number; clientId: string; name: string; monitorType: string; canView: boolean; receiveAlerts: boolean }> = [];

  if (scope.kind === 'all') {
    // Admin in group - show all assigned
    const access = groupService.getGroupWithCustomerDetails(ctx.chatId);
    customers = access;
  } else if (scope.kind === 'assigned') {
    const access = groupService.getGroupWithCustomerDetails(ctx.chatId);
    const allowedIds = new Set(scope.customerIds);
    customers = access.filter(c => allowedIds.has(c.customerId));
  } else {
    customers = [];
  }

  if (customers.length === 0) {
    await ctx.reply(formatWarning('No customers assigned to this group'));
    return;
  }

  const lines = ['👥 <b>GROUP CLIENTS</b>', ''];
  for (const c of customers) {
    const visibility = c.canView ? '👁 Visible' : '🚫 Hidden';
    const alerts = c.receiveAlerts ? '🔔 Alerts ON' : '🔕 Alerts OFF';
    lines.push(`#${c.clientId} ${c.name}`);
    lines.push(`  ${visibility} | ${alerts}`);
    lines.push('');
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  logger.info({ chatId: ctx.chatId, userId: ctx.from?.id.toString(), count: customers.length }, 'Group clients listed');
}