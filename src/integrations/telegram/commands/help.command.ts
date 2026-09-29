import type { BotContext } from '@/integrations/telegram/bot';
import { formatHelpMessage, formatAccessDenied } from '@/integrations/telegram/ui/messages';
import { accessService } from '@/modules/groups/access.service';
import { getConfig } from '@/config/env';

interface HelpCommand {
  command: string;
  description: string;
}

interface HelpCategory {
  title: string;
  commands: HelpCommand[];
}

const baseCommands: HelpCommand[] = [
  { command: 'help', description: 'Show this help' },
  { command: 'chatid', description: 'Show this chat ID' },
];

const dailyMonitoring: HelpCommand[] = [
  { command: 'summary', description: 'Status overview' },
  { command: 'status', description: 'Quick status by client_id' },
  { command: 'down', description: 'DOWN customers' },
];

const readCommands: HelpCommand[] = [
  { command: 'clients', description: 'Browse customers' },
  { command: 'clients <keyword>', description: 'Search by name or ID' },
  { command: 'client', description: 'Full details by client_id' },
];

const manageCustomerCommands: HelpCommand[] = [
  { command: 'add_client', description: 'Add new customer' },
  { command: 'enable_client', description: 'Enable customer' },
  { command: 'disable_client', description: 'Disable customer' },
  { command: 'delete_client', description: 'Delete customer permanently' },
  { command: 'csv_upload', description: 'Upload CSV to import customers' },
];

const adminGroupCommands: HelpCommand[] = [
  { command: 'assign_client', description: 'Assign customer to group' },
  { command: 'unassign_client', description: 'Unassign customer from group' },
  { command: 'group_alerts', description: 'Manage alert subscriptions: interactive menu or /group_alerts <client_id> on|off' },
  { command: 'unregister_group', description: 'Unregister this group' },
];

const readGroupCommands: HelpCommand[] = [
  { command: 'group_clients', description: 'List customers with alert state' },
];

const prtgMappingCommands: HelpCommand[] = [
  { command: 'prtg_inventory', description: 'Show/fetch PRTG inventory' },
  { command: 'prtg_search', description: 'Search PRTG sensors' },
  { command: 'map_client', description: 'Map customer to PRTG sensor' },
  { command: 'auto_map', description: 'Auto-match sensors' },
  { command: 'unmap_client', description: 'Remove PRTG mapping' },
  { command: 'mappings', description: 'List all PRTG mappings' },
];

function getHelpCommands(context: { userId: string; chatId: string; chatType: string }): HelpCategory[] {
  const config = getConfig();
  const isAdmin = accessService.isAdmin(context.userId);
  const isGlobalGroup = accessService.isGlobalGroup(context.chatId);
  const isPrivateChat = accessService.isPrivateChat(context.chatType);
  const isGroupChat = accessService.isGroupChat(context.chatType);
  const isGroupRegistered = isGroupChat && accessService.isGroupRegistered(context.chatId);
  const canManage = accessService.canManageCustomers(context);
  const canMap = accessService.canManageMappings(context);

  const utilities: HelpCommand[] = [...baseCommands];

  if (isPrivateChat && isGlobalGroup) {
    return [];
  }

  if (isPrivateChat) {
    if (!isAdmin) {
      return [{ title: 'Utilities', commands: utilities }];
    }
    const categories: HelpCategory[] = [
      { title: 'Daily Monitoring', commands: dailyMonitoring },
      { title: 'Customers', commands: [...readCommands, ...manageCustomerCommands] },
      { title: 'PRTG Mapping', commands: canMap ? prtgMappingCommands : [] },
      { title: 'Utilities', commands: utilities },
    ];
    return categories.filter((c) => c.commands.length > 0);
  }

  if (isGlobalGroup) {
    if (isAdmin) {
      const categories: HelpCategory[] = [
        { title: 'Daily Monitoring', commands: dailyMonitoring },
        { title: 'Customers', commands: [...readCommands, ...manageCustomerCommands] },
        { title: 'Groups & Alerts', commands: [...readGroupCommands, ...adminGroupCommands] },
        { title: 'PRTG Mapping', commands: prtgMappingCommands },
        { title: 'Utilities', commands: utilities },
      ];
      return categories.filter((c) => c.commands.length > 0);
    }
    const categories: HelpCategory[] = [
      { title: 'Daily Monitoring', commands: dailyMonitoring },
      { title: 'Customers', commands: readCommands },
      { title: 'Groups & Alerts', commands: [...readGroupCommands, ...(isAdmin ? adminGroupCommands : [])] },
      { title: 'Utilities', commands: utilities },
    ];
    return categories.filter((c) => c.commands.length > 0);
  }

  if (isGroupChat) {
    if (config.TELEGRAM_GLOBAL_GROUP_ID && context.chatId === config.TELEGRAM_GLOBAL_GROUP_ID) {
      return [{ title: 'Utilities', commands: utilities }];
    }

    if (isAdmin && isGroupRegistered) {
      const categories: HelpCategory[] = [
        { title: 'Daily Monitoring', commands: dailyMonitoring },
        { title: 'Customers', commands: readCommands },
        { title: 'Groups & Alerts', commands: [...readGroupCommands, ...adminGroupCommands] },
        { title: 'Utilities', commands: utilities },
      ];
      return categories.filter((c) => c.commands.length > 0);
    }

    if (!isGroupRegistered && isAdmin) {
      const categories: HelpCategory[] = [
        { title: 'Daily Monitoring', commands: dailyMonitoring },
        { title: 'Customers', commands: readCommands },
        { title: 'Utilities', commands: [...baseCommands, { command: 'register_group', description: 'Register this group (admin only)' }] },
      ];
      return categories.filter((c) => c.commands.length > 0);
    }

    if (isGroupRegistered && !isAdmin) {
      const categories: HelpCategory[] = [
        { title: 'Daily Monitoring', commands: dailyMonitoring },
        { title: 'Customers', commands: readCommands },
        { title: 'Groups & Alerts', commands: readGroupCommands },
        { title: 'Utilities', commands: utilities },
      ];
      return categories.filter((c) => c.commands.length > 0);
    }

    return [{ title: 'Utilities', commands: utilities }];
  }

  return [{ title: 'Utilities', commands: utilities }];
}

export async function helpCommand(ctx: BotContext): Promise<void> {
  const context = {
    userId: ctx.userId || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'private',
  };

  if (!context.userId || !context.chatId) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  const commands = getHelpCommands(context);
  let message: string;

  if (accessService.isGlobalGroup(context.chatId)) {
    if (accessService.isAdmin(context.userId)) {
      message = formatHelpMessage(commands, 'As a global group admin, you see all customers without assignment.');
    } else {
      message = formatHelpMessage(commands, 'As a read-only global group member, you can view but not modify customer data.');
    }
  } else {
    message = formatHelpMessage(commands);
  }

  await ctx.reply(message, { parse_mode: 'HTML' });
}
