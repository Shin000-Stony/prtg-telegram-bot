import type { BotContext } from '@/integrations/telegram/bot';
import { customerService } from '@/modules/customers/customer.service';
import { mappingService } from '@/modules/mapping/mapping.service';
import { accessService } from '@/modules/groups/access.service';
import { getPrtgInventoryCache, hasPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { formatCustomerDetail, formatAccessDenied, formatError, formatMappingCandidates, htmlEscape } from '@/integrations/telegram/ui/messages';
import { createMappingKeyboard, createVerifyMappingKeyboard } from '@/integrations/telegram/ui/cards';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import { statusService } from '@/modules/status/status.service';
import { formatStatusBrief } from '@/integrations/telegram/commands/status.command';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'ClientCommand' });

export async function clientCommand(ctx: BotContext): Promise<void> {
  const context = {
    userId: ctx.userId!,
    chatId: ctx.chatId!,
    chatType: ctx.chatType || 'private',
  };

  if (!ctx.message || !('text' in ctx.message)) {
    return;
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply(formatError('Usage: <b>/client</b> <code>&lt;client_id&gt;</code>'));
    return;
  }

  const clientId = parts[1].trim();

  // Check access scope FIRST to avoid existence leakage
  const scope = accessService.getCustomerAccessScope(context);
  if (scope.kind === 'none') {
    await ctx.reply(formatAccessDenied());
    return;
  }

  // For 'all' and 'assigned' scopes, we need to look up the customer
  const customer = customerService.getByClientId(clientId);
  if (!customer) {
    // For 'assigned' scope, use same message as access denied to avoid existence leakage
    // For 'all' scope, customer truly not found
    if (scope.kind === 'assigned') {
      await ctx.reply(formatAccessDenied());
    } else {
      await ctx.reply(formatError('Customer not found'));
    }
    return;
  }

  // Use AccessService for visibility check (includes scope check + can_view=1 filter)
  if (!accessService.canViewCustomer(context, customer.id)) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  const mapping = mappingService.getByCustomerId(customer.id);
  const isAdmin = accessService.canManageMappings(context);

  let message = formatCustomerDetail({
    ...customer,
    prtgMapping: mapping
      ? {
          objectId: mapping.prtgObjectId,
          deviceName: mapping.prtgDeviceName,
          sensorName: mapping.prtgSensorName,
          verified: mapping.verified,
        }
      : null,
  });

  const statusDetail = statusService.getCustomerStatus(
    { userId: context.userId, chatId: context.chatId, chatType: context.chatType },
    customer.clientId,
  );

  // Append status info after detail, using status.service rendering
   // Append status info after detail, using status.service rendering
  message += `\n${formatStatusBrief(statusDetail)}`;

  let keyboard: ReturnType<typeof createMappingKeyboard> | undefined;

   // Add kandidat/button for admin
if (isAdmin) {
      if (!mapping) {
        // No mapping - show kandidat to map
        if (hasPrtgInventoryCache()) {
          const snap = getPrtgInventoryCache()!.getFresh();
          if (snap) {
           const decision = mappingService.evaluateAutoMapping({
             customer,
             inventory: snap.sensors,
             existingMappings: mappingService.getAllMappings(),
           });

           if (decision.kind === 'automatic') {
             message += '\n\n<i>Auto-mapping available for <code>#' + htmlEscape(String(decision.objectId)) + '</code>'
               + (decision.confidence ? ` (${Math.round(decision.confidence * 100)}%)` : '') + '</i>';
             const searchSession = pendingMappingStore.createSearch({
               chatId: context.chatId,
               userId: context.userId,
               inventoryGeneration: snap.generation,
               customerId: customer.id,
               page: 1,
               candidates: [{ objectId: decision.objectId, deviceName: '', sensorName: '', sensorType: '' }],
             });
             keyboard = createMappingKeyboard(searchSession.id, customer.id, [decision.objectId]);
           } else if (decision.kind === 'suggestions' && decision.candidates.length > 0) {
             message += '\n\n' + formatMappingCandidates(decision.candidates);
             const objectIds = decision.candidates.slice(0, 5).map(c => c.prtgObjectId);
             const searchSession = pendingMappingStore.createSearch({
               chatId: context.chatId,
               userId: context.userId,
               inventoryGeneration: snap.generation,
               customerId: customer.id,
               page: 1,
               candidates: decision.candidates.slice(0, 5).map(c => ({
                 objectId: c.prtgObjectId,
                 deviceName: c.deviceName,
                 sensorName: c.sensorName,
                 sensorType: c.sensorType,
               })),
             });
             keyboard = createMappingKeyboard(searchSession.id, customer.id, objectIds);
           } else if (decision.kind === 'unresolved') {
             message += '\n\n<i>No automatic candidates found. Use /prtg_search to search manually.</i>';
           }
         } else {
           message += '\n\n<i>No fresh inventory available. Run /prtg_inventory refresh first.</i>';
         }
       }
      } else if (mapping && !mapping.verified && mapping.mappingMethod === 'auto') {
        // AUTO mapping exists but not verified by human - show verification button
        // Need a search session for verify flow
        if (hasPrtgInventoryCache()) {
          const snap = getPrtgInventoryCache()!.getFresh();
          if (snap) {
            const searchSession = pendingMappingStore.createSearch({
              chatId: context.chatId,
              userId: context.userId,
              inventoryGeneration: snap.generation,
              customerId: customer.id,
              page: 1,
              candidates: [{ objectId: mapping.prtgObjectId, deviceName: '', sensorName: '', sensorType: '' }],
            });
            message += '\n\n<i>Auto-mapping pending verification.</i>';
            keyboard = createVerifyMappingKeyboard(searchSession.id, customer.id, mapping.prtgObjectId);
          }
        }
      }
   }

  await ctx.reply(message, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });

  logger.info({ chatId: ctx.chatId, userId: ctx.userId, clientId }, 'Client detail sent');
}