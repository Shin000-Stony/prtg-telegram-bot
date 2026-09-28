import type { BotContext } from '@/integrations/telegram/bot';
import { formatHelpMessage, formatAccessDenied } from '@/integrations/telegram/ui/messages';
import { accessService } from '@/modules/groups/access.service';
import { getConfig } from '@/config/env';

function getHelpCommands(context: { userId: string; chatId: string; chatType: string }) {
  const config = getConfig();
  const isAdmin = accessService.isAdmin(context.userId);
  const isGlobalGroup = accessService.isGlobalGroup(context.chatId);
  const isPrivateChat = accessService.isPrivateChat(context.chatType);
  const isGroupChat = accessService.isGroupChat(context.chatType);
  const isGroupRegistered = isGroupChat && accessService.isGroupRegistered(context.chatId);

  const baseCommands = [
    { command: 'help', description: 'Show this help message' },
    { command: 'chatid', description: 'Show current chat ID and type' },
  ];

  const dailyMonitoring = [
    { command: 'summary', description: 'Show customer status summary' },
    { command: 'status', description: 'Show customer status' },
    { command: 'down', description: 'List DOWN customers' },
  ];

  const customers = [
    { command: 'clients', description: 'List all customers' },
    { command: 'client', description: 'Show customer detail' },
    { command: 'add_client', description: 'Add new customer' },
    { command: 'enable_client', description: 'Enable customer' },
    { command: 'disable_client', description: 'Disable customer' },
    { command: 'csv_upload', description: 'Upload CSV to import customers' },
  ];

  const prtgMapping = [
    { command: 'prtg_inventory', description: 'Show/fetch PRTG inventory' },
    { command: 'prtg_search', description: 'Search PRTG sensors' },
    { command: 'map_client', description: 'Map customer to PRTG sensor' },
    { command: 'auto_map', description: 'Auto-map PRTG sensors with preview confirmation' },
    { command: 'unmap_client', description: 'Remove PRTG mapping' },
    { command: 'mappings', description: 'List all PRTG mappings' },
  ];

  const groupsAlerts = [
    { command: 'group_clients', description: 'List customers with alert state' },
    { command: 'group_alerts', description: 'Toggle alert subscription: /group_alerts <client_id> on|off' },
    { command: 'assign_client', description: 'Assign customer to group' },
    { command: 'unassign_client', description: 'Unassign customer from group' },
    { command: 'register_group', description: 'Register this group' },
    { command: 'unregister_group', description: 'Unregister this group' },
  ];

  const utilities = [
    ...baseCommands,
  ];

  if (isAdmin) {
    if (isPrivateChat) {
      return [
        { title: 'Daily Monitoring', commands: dailyMonitoring },
        { title: 'Customers', commands: customers },
        { title: 'PRTG Mapping', commands: prtgMapping },
        { title: 'Utilities', commands: utilities },
      ];
    }

    if (isGlobalGroup) {
      return [
        { title: 'Daily Monitoring', commands: dailyMonitoring },
        { title: 'Customers', commands: customers },
        { title: 'Groups & Alerts', commands: [
          ...groupsAlerts,
        ] },
        { title: 'PRTG Mapping', commands: prtgMapping },
        { title: 'Utilities', commands: utilities },
      ];
    }
  }

  if (isGlobalGroup) {
    return [
      { title: 'Daily Monitoring', commands: dailyMonitoring },
      { title: 'Customers', commands: [
        { command: 'clients', description: 'List all customers (read-only)' },
        { command: 'client', description: 'Show customer detail (read-only)' },
      ] },
      { title: 'Groups & Alerts', commands: [
        { command: 'group_clients', description: 'List all customers with alert state' },
      ] },
      { title: 'Utilities', commands: utilities },
    ];
  }

  if (isGroupChat) {
    if (config.TELEGRAM_GLOBAL_GROUP_ID && context.chatId === config.TELEGRAM_GLOBAL_GROUP_ID) {
      return [{ title: 'Utilities', commands: utilities }];
    }

    if (isAdmin) {
      if (isGroupRegistered) {
        return [
          { title: 'Daily Monitoring', commands: dailyMonitoring },
          { title: 'Customers', commands: customers },
          { title: 'Groups & Alerts', commands: [
            { command: 'group_clients', description: 'List all customers with alert state' },
            { command: 'group_alerts', description: 'Toggle alert subscription: /group_alerts <client_id> on|off' },
            { command: 'assign_client', description: 'Assign customer to group' },
            { command: 'unassign_client', description: 'Unassign customer from group' },
            { command: 'unregister_group', description: 'Unregister this group' },
          ] },
          { title: 'PRTG Mapping', commands: prtgMapping },
          { title: 'Utilities', commands: utilities },
        ];
      } else {
        return [
          { title: 'Utilities', commands: [
            ...baseCommands,
            { command: 'register_group', description: 'Register this group' },
          ] },
        ];
      }
    }

    if (isGroupRegistered) {
      return [
        { title: 'Daily Monitoring', commands: dailyMonitoring },
        { title: 'Customers', commands: [
          { command: 'clients', description: 'List visible customers' },
          { command: 'client', description: 'Show customer detail' },
        ] },
        { title: 'Groups & Alerts', commands: [
          { command: 'group_clients', description: 'List visible customers with alert state' },
        ] },
        { title: 'Utilities', commands: utilities },
      ];
    } else {
      return [
        { title: 'Utilities', commands: [
          ...baseCommands,
          { command: 'register_group', description: 'Register this group (admin only)' },
        ] },
      ];
    }
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