import type { BotContext } from '@/integrations/telegram/bot';
import { accessService } from '@/modules/groups/access.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { alertRepository } from '@/modules/alerts/alert.repository';
import { pendingDeleteStore } from '@/modules/customers/pending-delete.store';
import { createDeleteConfirmKeyboard } from '@/integrations/telegram/ui/cards';
import { formatAccessDenied, formatDeleteClientPreview } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'DeleteClientCommand' });

export async function deleteClientCommand(ctx: BotContext): Promise<void> {
  const context = {
    userId: ctx.userId || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'private',
  };

  if (!context.userId || !context.chatId) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  if (!accessService.canManageCustomers(context)) {
    await ctx.reply(
      formatAccessDenied('This command requires admin privileges in private chat or global group'),
    );
    return;
  }

  if (!ctx.message || !('text' in ctx.message)) {
    return;
  }

  const match = ctx.message.text.match(/^\/delete_client\s+(.+)$/);
  if (!match) {
    await ctx.reply(
      'Usage: <b>/delete_client</b> <code>&lt;client_id&gt;</code>\n\nUse this command to permanently remove a customer and all associated data.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const clientId = match[1].trim();

  try {
    const customer = customerRepository.findByClientId(clientId);
    if (!customer) {
      await ctx.reply(`❌ Customer not found: <code>${clientId}</code>`);
      return;
    }

    const counts = {
      mappings: mappingRepository.findByCustomerId(customer.id) ? 1 : 0,
      groups: groupRepository.getAccessForCustomer(customer.id).length,
      alerts: alertRepository.findPendingByCustomer(customer.id).length,
    };

    const message = formatDeleteClientPreview(customer, counts);

    const session = pendingDeleteStore.create({
      customerId: customer.id,
      clientId: customer.clientId,
      name: customer.name,
      chatId: context.chatId,
      userId: context.userId,
    });

    await ctx.reply(message, {
      parse_mode: 'HTML',
      reply_markup: createDeleteConfirmKeyboard(session.id),
    });

    logger.info({ customerId: customer.id, clientId, chatId: context.chatId, userId: context.userId }, 'Delete confirmation requested');
  } catch (error) {
    logger.error({ err: error, clientId }, 'Failed to process delete client command');
    await ctx.reply('❌ Failed to process delete request. See logs for details.');
  }
}
