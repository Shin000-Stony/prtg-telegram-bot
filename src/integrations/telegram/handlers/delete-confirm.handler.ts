import type { BotContext } from '@/integrations/telegram/bot';
import { parseDeleteCallback } from '@/integrations/telegram/ui/cards';
import { pendingDeleteStore } from '@/modules/customers/pending-delete.store';
import { customerService } from '@/modules/customers/customer.service';
import { alertRepository } from '@/modules/alerts/alert.repository';
import { accessService } from '@/modules/groups/access.service';
import { runInTransaction } from '@/infrastructure/database/database';
import { formatError, formatDeleteClientSuccess, formatDeleteClientCancelled } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';
import type { Database } from 'better-sqlite3';

const logger = getLogger().child({ module: 'DeleteConfirmHandler' });

function cancelAlertsInTransaction(db: Database, customerId: number): number {
  const pendingAlerts = alertRepository.findPendingByCustomer(customerId);
  const now = Date.now();
  let cancelled = 0;
  for (const alert of pendingAlerts) {
    const result = db.prepare(`
      UPDATE alert_outbox
      SET status = 'cancelled', error_code = ?, error_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'sending')
    `).run('customer_removed', 'customer_removed', now, alert.id);
    if (result.changes === 1) {
      cancelled++;
    }
  }
  return cancelled;
}

export async function handleDeleteConfirm(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseDeleteCallback(ctx.callbackQuery.data);
  if (!parsed || parsed.action !== 'confirm') {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const session = pendingDeleteStore.get(parsed.token);
  if (!session) {
    await ctx.answerCbQuery('Delete session expired or invalid');
    await ctx.editMessageText(formatError('Delete session expired or invalid')).catch(() => {});
    return;
  }

  if (session.userId !== ctx.userId) {
    await ctx.answerCbQuery('Only the original requester can confirm');
    return;
  }

  if (session.chatId !== ctx.chatId) {
    await ctx.answerCbQuery('This delete request belongs to a different chat');
    return;
  }

  // Re-check authorization at confirmation time
  const context = {
    userId: ctx.userId || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'private',
  };
  if (!accessService.canManageCustomers(context)) {
    await ctx.answerCbQuery('No longer authorized to delete customers');
    await ctx.editMessageText(formatError('No longer authorized to delete customers')).catch(() => {});
    return;
  }

  await ctx.answerCbQuery('Deleting...');
  await ctx.editMessageText('⏳ Deleting customer...').catch(() => {});

  try {
    await runInTransaction((db) => {
      cancelAlertsInTransaction(db, session.customerId);

      const deleted = customerService.delete(session.customerId);
      if (!deleted) {
        throw new Error(`Customer ${session.customerId} was already deleted`);
      }
    });

    pendingDeleteStore.consume(parsed.token);

    await ctx.editMessageText(formatDeleteClientSuccess({ clientId: session.clientId, name: session.name }), { parse_mode: 'HTML' });
    logger.info({ customerId: session.customerId, clientId: session.clientId, userId: ctx.userId }, 'Customer deleted');
  } catch (error) {
    logger.error({ err: error, customerId: session.customerId }, 'Failed to delete customer');
    await ctx.editMessageText(formatError('Failed to delete customer. See logs for details.')).catch(() => {});
  }
}

export async function handleDeleteCancel(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseDeleteCallback(ctx.callbackQuery.data);
  if (!parsed || parsed.action !== 'cancel') {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const session = pendingDeleteStore.get(parsed.token);
  if (!session) {
    await ctx.answerCbQuery('Delete session expired or invalid');
    await ctx.editMessageText(formatError('Delete session expired')).catch(() => {});
    return;
  }

  if (session.userId !== ctx.userId) {
    await ctx.answerCbQuery('Only the original requester can cancel');
    return;
  }

  if (session.chatId !== ctx.chatId) {
    await ctx.answerCbQuery('This delete request belongs to a different chat');
    return;
  }

  pendingDeleteStore.delete(parsed.token);
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText(formatDeleteClientCancelled()).catch(() => {});
  logger.info({ customerId: session.customerId, userId: ctx.userId }, 'Customer deletion cancelled');
}
