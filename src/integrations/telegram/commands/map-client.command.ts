import type { BotContext } from '@/integrations/telegram/bot';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { mappingService } from '@/modules/mapping/mapping.service';
import { getPrtgInventoryCache, hasPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { createConfirmMappingKeyboard, createMappingKeyboard } from '@/integrations/telegram/ui/cards';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import { isSuggestionsDecision, isAutomaticDecision } from '@/modules/mapping/mapping.types';
import { formatError, formatAccessDenied, htmlEscape, parsePositiveInteger } from '@/integrations/telegram/ui/messages';
import type { InlineKeyboardMarkup } from 'telegraf/types';

function getCache() {
  return getPrtgInventoryCache();
}

function hasCache() {
  return hasPrtgInventoryCache();
}

export async function mapClientCommand(ctx: BotContext): Promise<void> {
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

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    await ctx.reply(formatError('Usage: /map_client <client_id> [object_id]'));
    return;
  }

  const clientId = parts[1];
  const objectIdArg = parts[2] ? parsePositiveInteger(parts[2]) : null;

  if (parts[2] && objectIdArg === null) {
    await ctx.reply(formatError('Object ID must be a positive integer'));
    return;
  }

  const customer = customerService.getByClientId(clientId);
  if (!customer) {
    await ctx.reply(formatError('Customer not found'));
    return;
  }

  if (!customer.enabled || customer.monitorType !== 'prtg') {
    await ctx.reply(formatError('Customer must be enabled and use PRTG monitor type'));
    return;
  }

  const existingMapping = mappingService.getByCustomerId(customer.id);
  if (existingMapping) {
    await ctx.reply(formatError('Customer already has a mapping. Use /unmap_client first.'));
    return;
  }

  if (objectIdArg) {
    await showConfirmMap(ctx, context, customer, objectIdArg, clientId);
  } else {
    await showMappingCandidates(ctx, context, customer, clientId);
  }
}

async function showMappingCandidates(ctx: BotContext, context: any, customer: any, _clientId: string): Promise<void> {
  if (!hasCache()) {
    await ctx.reply(formatError('PRTG inventory cache not initialized'));
    return;
  }
  const cache = getCache()!;
  const snap = cache.getFresh();
  if (!snap) {
    await ctx.reply(formatError('No fresh inventory available. Run /prtg_inventory refresh first.'));
    return;
  }

  const decision = mappingService.evaluateAutoMapping({
    customer,
    inventory: snap.sensors,
    existingMappings: mappingService.getAllMappings(),
  });

  const lines = [
    `🗺 <b>MAP CLIENT</b>`,
    `Customer  : ${htmlEscape(customer.name)} (${htmlEscape(customer.clientId)})`,
    `Decision  : ${formatDecision(decision)}`,
    '',
    decision.kind === 'automatic'
      ? `Auto-mapping available for <code>#${decision.objectId}</code> (${htmlEscape(decision.reason)})`
      : 'Select a sensor to map:',
  ];

  let objectIds: number[];

  if (decision.kind === 'automatic') {
    objectIds = [decision.objectId];
  } else if (decision.kind === 'suggestions' && decision.candidates.length > 0) {
    lines.push('', '<b>Suggestions:</b>');
    for (const c of decision.candidates.slice(0, 5)) {
      lines.push(`<code>#${c.prtgObjectId}</code> — ${htmlEscape(c.deviceName)} — ${htmlEscape(c.sensorName)} (${htmlEscape(c.sensorType)}) — ${Math.round(c.confidence * 100)}%`);
    }
    objectIds = decision.candidates.slice(0, 5).map(c => c.prtgObjectId);
  } else {
    objectIds = [];
  }

  if (objectIds.length === 0 && decision.kind !== 'automatic') {
    lines.push('', '<i>No eligible Ping sensors found. Use /prtg_search to search manually.</i>');
  }

  let keyboard: InlineKeyboardMarkup | undefined;
  if (objectIds.length > 0) {
    // Create a search session for session-bound callbacks
    let candidates: Array<{ objectId: number; deviceName: string; sensorName: string; sensorType: string }>;
    if (isSuggestionsDecision(decision)) {
      candidates = decision.candidates.slice(0, 5).map(c => ({
        objectId: c.prtgObjectId,
        deviceName: c.deviceName,
        sensorName: c.sensorName,
        sensorType: c.sensorType,
      }));
    } else if (isAutomaticDecision(decision)) {
      candidates = [{ objectId: decision.objectId, deviceName: '', sensorName: '', sensorType: '' }];
    } else {
      // This should not happen since objectIds.length > 0 implies automatic or suggestions
      candidates = [];
    }
    const searchSession = pendingMappingStore.createSearch({
      chatId: context.chatId,
      userId: context.userId,
      inventoryGeneration: snap.generation,
      customerId: customer.id,
      page: 1,
      candidates,
    });
    keyboard = createMappingKeyboard(searchSession.id, customer.id, objectIds);
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

async function showConfirmMap(ctx: BotContext, context: any, customer: any, objectId: number, clientId: string): Promise<void> {
  if (!hasCache()) {
    await ctx.reply(formatError('PRTG inventory cache not initialized'));
    return;
  }
  const cache = getCache()!;
  const snap = cache.getFresh();
  if (!snap) {
    await ctx.reply(formatError('No fresh inventory available. Run /prtg_inventory refresh first.'));
    return;
  }

  const sensor = snap.sensors.find(s => s.objectId === objectId);
  if (!sensor) {
    await ctx.reply(formatError('Sensor not found in current inventory'));
    return;
  }

  if (sensor.sensorType.toLowerCase() !== 'ping') {
    await ctx.reply(formatError('Only Ping sensors can be mapped'));
    return;
  }

  const { token, preview } = mappingService.prepareMapping(clientId, objectId, context, snap);

  const lines = [
    `🗺 <b>CONFIRM MAPPING</b>`,
    `Customer  : ${htmlEscape(preview.customer.name)} (${htmlEscape(preview.customer.clientId)})`,
    `Sensor    : <code>#${preview.sensor.objectId}</code> — ${htmlEscape(preview.sensor.deviceName)} — ${htmlEscape(preview.sensor.sensorName)} (${htmlEscape(preview.sensor.sensorType)})`,
    '',
    preview.conflictReason ? `⚠️ <b>Conflict:</b> ${htmlEscape(preview.conflictReason)}` : 'No conflicts detected',
  ];

  const keyboard = createConfirmMappingKeyboard(token, customer.id, objectId);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

function formatDecision(decision: any): string {
  switch (decision.kind) {
    case 'automatic':
      return `🤖 AUTO (${Math.round(decision.confidence * 100)}%) — ${decision.reason}`;
    case 'suggestions':
      return `💡 SUGGESTIONS (${decision.candidates.length} candidates)`;
    case 'unresolved':
      return `❓ UNRESOLVED — ${decision.reason}`;
    default:
      return 'Unknown';
  }
}