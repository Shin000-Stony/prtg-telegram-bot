import type { BotContext } from '@/integrations/telegram/bot';
import { customerService } from '@/modules/customers/customer.service';
import { accessService } from '@/modules/groups/access.service';
import { formatSuccess, formatError, formatAccessDenied, formatWarning } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'ClientStateCommand' });

async function handleClientState(
  ctx: BotContext,
  clientId: string,
  enabled: boolean,
  action: string
): Promise<void> {
  const context = {
    userId: ctx.userId!,
    chatId: ctx.chatId!,
    chatType: ctx.chatType || 'private',
  };

  if (!accessService.canManageCustomers(context)) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  const customer = customerService.getByClientId(clientId);
  if (!customer) {
    await ctx.reply(formatError('Customer not found'));
    return;
  }

  if (customer.enabled === enabled) {
    await ctx.reply(formatWarning(`Customer is already ${enabled ? 'enabled' : 'disabled'}`));
    return;
  }

  try {
    const updated = customerService.update(customer.id, { enabled });
    await ctx.reply(
      formatSuccess(`Customer ${action}d\nClient ID: ${updated.clientId}\nName: ${updated.name}\nState: ${updated.enabled ? 'Enabled' : 'Disabled'}`)
    );
    logger.info({ chatId: ctx.chatId, userId: ctx.userId, clientId: updated.clientId, enabled: updated.enabled }, `Customer ${action}d`);
  } catch (error) {
    logger.error({ err: error }, `Failed to ${action} customer`);
    await ctx.reply(formatError(`Failed to ${action} customer`));
  }
}

export async function enableClientCommand(ctx: BotContext): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) {
    return;
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply(formatError('Usage: /enable_client <client_id>'));
    return;
  }

  await handleClientState(ctx, parts[1].trim(), true, 'enable');
}

export async function disableClientCommand(ctx: BotContext): Promise<void> {
  if (!ctx.message || !('text' in ctx.message)) {
    return;
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply(formatError('Usage: /disable_client <client_id>'));
    return;
  }

  await handleClientState(ctx, parts[1].trim(), false, 'disable');
}