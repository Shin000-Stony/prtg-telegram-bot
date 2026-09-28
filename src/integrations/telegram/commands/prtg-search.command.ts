import type { BotContext } from '@/integrations/telegram/bot';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import { getPrtgInventoryCache, hasPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { createSearchKeyboard } from '@/integrations/telegram/ui/cards';
import { formatError, formatAccessDenied, formatInfo, htmlEscape, parsePositiveInteger } from '@/integrations/telegram/ui/messages';

function getCache() {
  return getPrtgInventoryCache();
}

function hasCache() {
  return hasPrtgInventoryCache();
}

export async function prtgSearchCommand(ctx: BotContext): Promise<void> {
  const context = {
    userId: ctx.userId || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'private',
  };

  if (!context.userId || !context.chatId) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  if (!hasCache()) {
    await ctx.reply(formatError('PRTG inventory cache not initialized'));
    return;
  }

  const cache = getCache()!;
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) {
    await ctx.reply(formatError('Usage: /prtg_search <client_id> <query or #object_id>'));
    return;
  }

  const clientId = parts[1];
  const query = parts.slice(2).join(' ').trim();

  const customer = customerService.getByClientId(clientId);
  if (!customer) {
    await ctx.reply(formatError('Customer not found'));
    return;
  }

  if (!customer.enabled || customer.monitorType !== 'prtg') {
    await ctx.reply(formatError('Customer must be enabled and use PRTG monitor type'));
    return;
  }

  const snap = cache.getFresh();
  if (!snap) {
    await ctx.reply(formatInfo('No fresh inventory available. Run /prtg_inventory refresh first.'));
    return;
  }

  let candidates = snap.sensors.filter(s => s.sensorType.toLowerCase() === 'ping');

  let objectIdQuery: number | null = null;
  if (query.startsWith('#')) {
    objectIdQuery = parsePositiveInteger(query.slice(1));
    if (objectIdQuery === null) {
      await ctx.reply(formatError('Invalid object ID format'));
      return;
    }
  }

  if (objectIdQuery !== null) {
    candidates = candidates.filter(s => s.objectId === objectIdQuery!);
  } else {
    const lowerQuery = query.toLowerCase();
    candidates = candidates.filter(s =>
      s.deviceName.toLowerCase().includes(lowerQuery) ||
      s.sensorName.toLowerCase().includes(lowerQuery)
    );
  }

  if (candidates.length === 0) {
    await ctx.reply(formatInfo('No matching Ping sensors found.'));
    return;
  }

  const pageSize = 5;
  const totalPages = Math.ceil(candidates.length / pageSize);
  const pageCandidates = candidates.slice(0, pageSize);

  // Create a search session to enable pagination with query context
  // Store ALL candidates so pagination doesn't require re-filtering
  const searchSession = pendingMappingStore.createSearch({
    chatId: context.chatId,
    userId: context.userId,
    inventoryGeneration: snap.generation,
    customerId: customer.id,
    page: 1,
    candidates: candidates.map(c => ({
      objectId: c.objectId,
      deviceName: c.deviceName,
      sensorName: c.sensorName,
      sensorType: c.sensorType,
    })),
  });

  const lines = [
    `🔍 <b>SEARCH RESULTS</b>`,
    `Customer  : ${htmlEscape(customer.name)} (${htmlEscape(customer.clientId)})`,
    `Query     : ${htmlEscape(query)}`,
    `Matches   : ${candidates.length}`,
    '',
  ];

  for (const c of pageCandidates) {
    lines.push(`<code>#${c.objectId}</code> — ${htmlEscape(c.deviceName)} — ${htmlEscape(c.sensorName)} (${htmlEscape(c.sensorType)})`);
  }

  if (totalPages > 1) {
    lines.push('', `Page 1/${totalPages}`);
  }

  const keyboard = createSearchKeyboard(searchSession.id, customer.id, pageCandidates.map(c => c.objectId), 1, totalPages);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}