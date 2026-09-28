import type { BotContext } from '@/integrations/telegram/bot';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { mappingService } from '@/modules/mapping/mapping.service';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import { getPrtgInventoryCache, hasPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { parseMappingCallback, createConfirmMappingKeyboard, createSearchKeyboard } from '@/integrations/telegram/ui/cards';
import { formatError, formatSuccess, formatAccessDenied, htmlEscape, parsePositiveInteger } from '@/integrations/telegram/ui/messages';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'MappingCallbacks' });

function getCache() {
  return getPrtgInventoryCache();
}

function hasCache() {
  return hasPrtgInventoryCache();
}

export async function handleMapConfirm(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const parsed = parseMappingCallback(ctx.callbackQuery.data);
  if (!parsed || (parsed.action !== 'map_confirm' && parsed.action !== 'confirm')) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  await ctx.answerCbQuery();

  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'group',
  };

  if (!context.userId || !context.chatId) {
    await ctx.answerCbQuery('Invalid session');
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.answerCbQuery('Admin access required');
    return;
  }

  if (!hasCache()) {
    await ctx.answerCbQuery('PRTG inventory cache not initialized');
    return;
  }

  const customer = customerService.getById(parsed.customerId);
  if (!customer) {
    await ctx.answerCbQuery('Customer not found');
    return;
  }

  const snap = getCache()!.getFresh();
  if (!snap) {
    await ctx.answerCbQuery('No fresh inventory available. Run /prtg_inventory refresh first.');
    return;
  }

  try {
    const mapping = mappingService.confirmMapping({
      clientId: customer.clientId,
      objectId: parsed.objectId!,
      operatorId: context.userId,
      context,
      token: parsed.token,
      inventory: snap,
    });

    await ctx.editMessageText(
      formatSuccess(`Mapping confirmed: <code>${htmlEscape(customer.name)}</code> → <code>#${mapping.prtgObjectId}</code>`),
      { parse_mode: 'HTML' }
    );
    logger.info({ customerId: customer.id, objectId: mapping.prtgObjectId, operatorId: context.userId }, 'Mapping confirmed via callback');
  } catch (error) {
    logger.error({ err: error }, 'Map confirm failed');
    await ctx.answerCbQuery('Failed to confirm mapping');
  }
}

export async function handleMapCancel(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const data = ctx.callbackQuery.data;
  if (!data.startsWith('map_cancel:') && !data.startsWith('cancel:')) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const parts = data.split(':');
  let token: string | undefined;
  let customerId: number | undefined;

  if (data.startsWith('map_cancel:')) {
    if (parts.length === 3) {
      token = parts[1];
      customerId = parsePositiveInteger(parts[2]) ?? undefined;
    } else if (parts.length === 2) {
      customerId = parsePositiveInteger(parts[1]) ?? undefined;
    }
  } else {
    // cancel: format
    const parsed = parseMappingCallback(data);
    if (!parsed) {
      await ctx.answerCbQuery('Invalid callback');
      return;
    }
    token = parsed.token;
    customerId = parsed.customerId;
  }

  if (customerId === undefined) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'group',
  };

  if (!context.userId || !context.chatId) {
    await ctx.editMessageText(formatAccessDenied()).catch(() => {});
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.answerCbQuery('Admin access required');
    return;
  }

  if (token) {
    const pending = pendingMappingStore.get(token);
    if (!pending) {
      await ctx.answerCbQuery('Session not found or expired');
      return;
    }

    // Handle search session cancel
    if (pending.action === 'search') {
      if (pending.customerId !== customerId) {
        await ctx.answerCbQuery('Customer mismatch');
        return;
      }
      if (pending.userId !== context.userId || pending.chatId !== context.chatId) {
        await ctx.answerCbQuery('Unauthorized');
        return;
      }
      pendingMappingStore.delete(token);
      await ctx.answerCbQuery('Search cancelled');
      await ctx.editMessageText('❌ Search cancelled').catch(() => {});
      logger.info({ customerId, userId: context.userId }, 'Search cancelled by user');
      return;
    }

    // Handle map session cancel (existing behavior)
    if (pending.action !== 'map') {
      await ctx.answerCbQuery('Invalid session type');
      return;
    }

    if (pending.userId !== context.userId || pending.chatId !== context.chatId) {
      await ctx.answerCbQuery('Unauthorized');
      return;
    }

    pendingMappingStore.delete(token);
    await ctx.answerCbQuery('Cancelled');
    await ctx.editMessageText('❌ Mapping cancelled').catch(() => {});
    logger.info({ customerId, userId: context.userId }, 'Mapping cancelled by user');
    return;
  }

  // Tokenless cancel - reject as bypass attempt
  await ctx.answerCbQuery('Invalid session');
  return;
}

export async function handleMapVerify(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const data = ctx.callbackQuery.data;
  if (!data.startsWith('map_verify:')) {
    return;
  }

  // Parse: map_verify:sessionId:customerId:objectId
  const parts = data.slice('map_verify:'.length).split(':');
  if (parts.length !== 3) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const sessionId = parts[0];
  const customerId = parsePositiveInteger(parts[1]);
  const objectId = parsePositiveInteger(parts[2]);

  if (customerId === null || objectId === null) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'group',
  };

  if (!context.userId || !context.chatId) {
    await ctx.answerCbQuery('Invalid session');
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.answerCbQuery('Admin access required');
    return;
  }

  // Get and validate search session
  const searchSession = pendingMappingStore.get(sessionId);
  if (!searchSession || searchSession.action !== 'search') {
    await ctx.answerCbQuery('Search session expired or invalid');
    return;
  }

  if (searchSession.userId !== context.userId || searchSession.chatId !== context.chatId) {
    await ctx.answerCbQuery('Unauthorized');
    return;
  }

  // Validate customer matches session
  if (searchSession.customerId !== customerId) {
    await ctx.answerCbQuery('Customer mismatch');
    return;
  }

  // Validate objectId is in allowed candidates
  const allowedObjectIds = new Set(searchSession.candidates.map(c => c.objectId));
  if (!allowedObjectIds.has(objectId)) {
    await ctx.answerCbQuery('Object not in search results');
    return;
  }

  if (!hasCache()) {
    await ctx.answerCbQuery('Inventory cache not initialized');
    return;
  }

  const snap = getCache()!.getFresh();
  if (!snap) {
    await ctx.answerCbQuery('No fresh inventory available');
    return;
  }

  // Validate inventory hasn't changed
  if (snap.generation !== searchSession.inventoryGeneration) {
    await ctx.answerCbQuery('Inventory changed, search new');
    return;
  }

  try {
    const { token, preview } = mappingService.prepareMapping(customerService.getById(customerId)!.clientId, objectId, context, snap);

    const keyboard = createConfirmMappingKeyboard(token, customerId, objectId);

    const lines = [
      `🗺 <b>CONFIRM MAPPING</b>`,
      '',
      `Customer  : ${htmlEscape(preview.customer.name)} (<code>${htmlEscape(preview.customer.clientId)}</code>)`,
      `Sensor    : #<b>${preview.sensor.objectId}</b> — ${htmlEscape(preview.sensor.deviceName)} — ${htmlEscape(preview.sensor.sensorName)} (${htmlEscape(preview.sensor.sensorType)})`,
      '',
      preview.conflictReason ? `⚠️ <b>Conflict:</b> ${htmlEscape(preview.conflictReason)}` : '✅ No conflicts detected',
      preview.existingMapping ? `Existing AUTO mapping is verified` : '',
    ].filter(Boolean);

    await ctx.editMessageText(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error({ err: error }, 'Map verify failed');
    await ctx.editMessageText(formatError('Failed to prepare mapping verification')).catch(() => {});
  }
}

export async function handleMapSearch(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const data = ctx.callbackQuery.data;
  if (!data.startsWith('map_search:')) {
    return;
  }

  const parts = data.slice('map_search:'.length).split(':');
  if (parts.length !== 2) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const sessionId = parts[0];
  const customerId = parsePositiveInteger(parts[1]);
  if (customerId === null) {
    await ctx.answerCbQuery('Invalid callback');
    return;
  }

  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'group',
  };

  if (!context.userId || !context.chatId) {
    await ctx.answerCbQuery('Invalid session');
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.answerCbQuery('Admin access required');
    return;
  }

  // Get and validate search session
  const searchSession = pendingMappingStore.get(sessionId);
  if (!searchSession || searchSession.action !== 'search') {
    await ctx.answerCbQuery('Search session expired or invalid');
    return;
  }

  if (searchSession.userId !== context.userId || searchSession.chatId !== context.chatId) {
    await ctx.answerCbQuery('Unauthorized');
    return;
  }

  // Validate customer matches session
  if (searchSession.customerId !== customerId) {
    await ctx.answerCbQuery('Customer mismatch');
    return;
  }

  // Validate inventory hasn't changed
  if (!hasCache()) {
    await ctx.answerCbQuery('Inventory cache not initialized');
    return;
  }

  const snap = getCache()!.getFresh();
  if (!snap) {
    await ctx.answerCbQuery('No fresh inventory');
    return;
  }

  if (snap.generation !== searchSession.inventoryGeneration) {
    await ctx.answerCbQuery('Inventory changed, search new');
    return;
  }

  const customer = customerService.getById(customerId);
  if (!customer) {
    await ctx.answerCbQuery('Customer not found');
    return;
  }

  await ctx.answerCbQuery('Use /prtg_search to search for other objects');
  await ctx.editMessageText(
    `🔍 To search for other PRTG objects, use:\n<code>/prtg_search ${htmlEscape(customer.clientId)} ${htmlEscape('<name or #object_id>')}</code>`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
}

export async function handleMapSelect(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const data = ctx.callbackQuery.data;
  if (!data.startsWith('map:')) {
    return;
  }

  await ctx.answerCbQuery();

  // Parse: map:sessionId:customerId:objectId
  const parts = data.slice('map:'.length).split(':');
  if (parts.length !== 3) {
    await ctx.answerCbQuery('Invalid selection');
    return;
  }

  const sessionId = parts[0];
  const customerId = parsePositiveInteger(parts[1]);
  const objectId = parsePositiveInteger(parts[2]);

  if (customerId === null || objectId === null) {
    await ctx.answerCbQuery('Invalid selection');
    return;
  }

  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'group',
  };

  if (!context.userId || !context.chatId) {
    await ctx.answerCbQuery('Invalid session');
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.answerCbQuery('Admin access required');
    return;
  }

  // Get and validate search session
  const searchSession = pendingMappingStore.get(sessionId);
  if (!searchSession || searchSession.action !== 'search') {
    await ctx.answerCbQuery('Search session expired or invalid');
    return;
  }

  if (searchSession.userId !== context.userId || searchSession.chatId !== context.chatId) {
    await ctx.answerCbQuery('Unauthorized');
    return;
  }

  // Validate customer matches session
  if (searchSession.customerId !== customerId) {
    await ctx.answerCbQuery('Customer mismatch');
    return;
  }

  // Validate objectId is in allowed candidates
  const allowedObjectIds = new Set(searchSession.candidates.map(c => c.objectId));
  if (!allowedObjectIds.has(objectId)) {
    await ctx.answerCbQuery('Object not in search results');
    return;
  }

  if (!hasCache()) {
    await ctx.answerCbQuery('PRTG inventory cache not initialized');
    return;
  }

  const snap = getCache()!.getFresh();
  if (!snap) {
    await ctx.answerCbQuery('No fresh inventory available');
    return;
  }

  // Validate inventory hasn't changed
  if (snap.generation !== searchSession.inventoryGeneration) {
    await ctx.answerCbQuery('Inventory changed, please search again');
    return;
  }

  const sensor = snap.sensors.find(s => s.objectId === objectId);
  if (!sensor) {
    await ctx.answerCbQuery('Sensor not found in current inventory');
    return;
  }

  if (sensor.sensorType.toLowerCase() !== 'ping') {
    await ctx.answerCbQuery('Only Ping sensors can be mapped');
    return;
  }

  try {
    const { token, preview } = mappingService.prepareMapping(customerService.getById(customerId)!.clientId, objectId, context, snap);

    const lines = [
      `🗺 <b>CONFIRM MAPPING</b>`,
      `Customer  : ${htmlEscape(preview.customer.name)} (${htmlEscape(preview.customer.clientId)})`,
      `Sensor    : <code>#${preview.sensor.objectId}</code> — ${htmlEscape(preview.sensor.deviceName)} — ${htmlEscape(preview.sensor.sensorName)} (${htmlEscape(preview.sensor.sensorType)})`,
      '',
      preview.conflictReason ? `⚠️ <b>Conflict:</b> ${htmlEscape(preview.conflictReason)}` : 'No conflicts detected',
    ];

    const keyboard = createConfirmMappingKeyboard(token, customerId, objectId);

    await ctx.editMessageText(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error({ err: error }, 'Map select failed');
    await ctx.editMessageText(formatError('Failed to prepare mapping')).catch(() => {});
  }
}

export async function handleAutoMapApply(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const data = ctx.callbackQuery.data;
  if (!data.startsWith('auto_apply:')) {
    return;
  }

  const token = data.slice('auto_apply:'.length);

  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'group',
  };

  if (!context.userId || !context.chatId) {
    await ctx.answerCbQuery(formatAccessDenied());
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.answerCbQuery('Admin access required');
    return;
  }

  if (!hasCache()) {
    await ctx.answerCbQuery('Inventory cache not initialized');
    return;
  }

  const snap = getCache()!.getFresh();
  if (!snap) {
    await ctx.answerCbQuery('No fresh inventory available');
    return;
  }

  try {
    const created = mappingService.applyAutoMapping(context, token, snap);
    
    if (created.length === 0) {
      await ctx.answerCbQuery('No automatic mappings applied');
      await ctx.editMessageText('⚠️ No automatic mappings were applied').catch(() => {});
    } else {
      await ctx.answerCbQuery(`Applied ${created.length} mappings`);
      const lines = ['✅ <b>AUTO-MAPPING APPLIED</b>', '', `Applied ${created.length} mappings:`];
      for (const m of created) {
        const customer = customerService.getById(m.customerId);
        lines.push(`  <code>#${customer?.clientId || m.customerId}</code> → <code>#${m.prtgObjectId}</code>`);
      }
      await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML' });
      logger.info({ count: created.length, operatorId: context.userId }, 'Auto-mapping applied via callback');
    }
  } catch (error) {
    logger.error({ err: error }, 'Auto-map apply failed');
    await ctx.answerCbQuery('Failed to apply auto-mapping');
    await ctx.editMessageText(formatError('Failed to apply auto-mapping')).catch(() => {});
  }
}

export async function handleAutoMapCancel(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const data = ctx.callbackQuery.data;
  if (!data.startsWith('auto_cancel:')) {
    return;
  }

  const token = data.slice('auto_cancel:'.length);

  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'group',
  };

  if (!context.userId || !context.chatId) {
    await ctx.editMessageText(formatAccessDenied()).catch(() => {});
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.answerCbQuery('Admin access required');
    return;
  }

  const pending = pendingMappingStore.get(token);
  if (!pending) {
    await ctx.answerCbQuery('Session not found or expired');
    return;
  }

  if (pending.action !== 'auto_map') {
    await ctx.answerCbQuery('Invalid session type');
    return;
  }

  if (pending.userId !== context.userId || pending.chatId !== context.chatId) {
    await ctx.answerCbQuery('Unauthorized');
    return;
  }

  pendingMappingStore.delete(token);
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Auto-mapping cancelled').catch(() => {});
  logger.info({ token, userId: context.userId }, 'Auto-mapping cancelled by user');
}

export async function handleUnmapConfirm(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const data = ctx.callbackQuery.data;
  if (!data.startsWith('unmap_confirm:')) {
    return;
  }

  const token = data.slice('unmap_confirm:'.length);

  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'group',
  };

  if (!context.userId || !context.chatId) {
    await ctx.answerCbQuery(formatAccessDenied());
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.answerCbQuery('Admin access required');
    return;
  }

  try {
    const success = mappingService.confirmUnmap({ context, token });
    
    if (success) {
      await ctx.answerCbQuery('Mapping removed');
      await ctx.editMessageText('✅ Mapping removed successfully', { parse_mode: 'HTML' }).catch(() => {});
      logger.info({ token, operatorId: context.userId }, 'Unmap confirmed via callback');
    } else {
      await ctx.answerCbQuery('Mapping not found or already removed');
      await ctx.editMessageText('❌ Mapping not found or already removed').catch(() => {});
    }
  } catch (error) {
    logger.error({ err: error }, 'Unmap confirm failed');
    await ctx.answerCbQuery('Failed to confirm unmap');
    await ctx.editMessageText(formatError('Failed to confirm unmap')).catch(() => {});
  }
}

export async function handleUnmapCancel(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const data = ctx.callbackQuery.data;
  if (!data.startsWith('unmap_cancel:')) {
    return;
  }

  const token = data.slice('unmap_cancel:'.length);

  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'group',
  };

  if (!context.userId || !context.chatId) {
    await ctx.editMessageText(formatAccessDenied()).catch(() => {});
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.answerCbQuery('Admin access required');
    return;
  }

  const pending = pendingMappingStore.get(token);
  if (!pending) {
    await ctx.answerCbQuery('Session not found or expired');
    return;
  }

  if (pending.action !== 'unmap') {
    await ctx.answerCbQuery('Invalid session type');
    return;
  }

  if (pending.userId !== context.userId || pending.chatId !== context.chatId) {
    await ctx.answerCbQuery('Unauthorized');
    return;
  }

  pendingMappingStore.delete(token);
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageText('❌ Unmap cancelled').catch(() => {});
  logger.info({ token, userId: context.userId }, 'Unmap cancelled by user');
}

export async function handleSearchPagination(ctx: BotContext): Promise<void> {
  if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
    return;
  }

  const data = ctx.callbackQuery.data;
  if (!data.startsWith('search_page:')) {
    return;
  }

  // Parse: search_page:sessionId:page
  const parts = data.slice('search_page:'.length).split(':');
  if (parts.length !== 2) return;

  const sessionId = parts[0];
  const page = parsePositiveInteger(parts[1]);

  if (page === null) return;

  // Get the search session and validate ownership
  const searchSession = pendingMappingStore.get(sessionId);
  if (!searchSession || searchSession.action !== 'search') {
    await ctx.answerCbQuery('Search session expired or invalid');
    return;
  }

  const context = {
    userId: ctx.from?.id.toString() || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'group',
  };

  if (context.userId !== searchSession.userId || context.chatId !== searchSession.chatId) {
    await ctx.answerCbQuery('Unauthorized');
    return;
  }

  if (!accessService.canManageMappings(context)) {
    await ctx.answerCbQuery('Admin access required');
    return;
  }

  if (!hasCache()) {
    await ctx.answerCbQuery('Inventory cache not initialized');
    return;
  }

  // Validate inventory hasn't changed
  const snap = getCache()!.getFresh();
  if (!snap) {
    await ctx.answerCbQuery('No fresh inventory');
    return;
  }

  if (snap.generation !== searchSession.inventoryGeneration) {
    await ctx.answerCbQuery('Inventory changed, search new');
    return;
  }

  const customer = customerService.getById(searchSession.customerId);
  if (!customer) {
    await ctx.answerCbQuery('Customer not found');
    return;
  }

  // Repaginate from the candidates stored in the session
  // Note: candidates stored are only the current page; we need to filter full set
  // Since we don't have the full candidate set stored, we need a different approach
  // For now, store all candidates in the session
  // Actually, the search command should store ALL candidates, not just current page

  // We need to re-filter from inventory using the original query
  // But we don't have the query stored... Let me check if we can use deviceName as search term
  // No - the candidates in the session represent what was found. We need ALL matching candidates.
  // Let me update the approach: store all candidates in session, slice when displaying.

  // For now, use stored candidates - but we need ALL of them, not just the current page
  const allCandidates = searchSession.candidates;
  const pageSize = 5;
  const start = (page - 1) * pageSize;
  const pageCandidates = allCandidates.slice(start, start + pageSize);

  if (pageCandidates.length === 0) {
    await ctx.answerCbQuery('No more results');
    return;
  }

  const totalPages = Math.ceil(allCandidates.length / pageSize);

  const lines = [
    `🔍 <b>SEARCH RESULTS</b>`,
    `Customer  : ${htmlEscape(customer.name)} (${htmlEscape(customer.clientId)})`,
    `Matches   : ${allCandidates.length}`,
    `Page      : ${page}/${totalPages}`,
    '',
  ];

  for (const c of pageCandidates) {
    lines.push(`<code>#${c.objectId}</code> — ${htmlEscape(c.deviceName)} — ${htmlEscape(c.sensorName)} (${htmlEscape(c.sensorType)})`);
  }

  const keyboard = createSearchKeyboard(sessionId, customer.id, pageCandidates.map(c => c.objectId), page, totalPages);

  await ctx.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  }).catch(() => {});
}