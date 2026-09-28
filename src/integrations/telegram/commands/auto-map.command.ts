import type { BotContext } from '@/integrations/telegram/bot';
import { accessService } from '@/modules/groups/access.service';
import { mappingService } from '@/modules/mapping/mapping.service';
import { getPrtgInventoryCache, hasPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { createConfirmAutoMappingKeyboard } from '@/integrations/telegram/ui/cards';
import { formatError, formatAccessDenied, htmlEscape } from '@/integrations/telegram/ui/messages';

function getCache() {
  return getPrtgInventoryCache();
}

function hasCache() {
  return hasPrtgInventoryCache();
}

export async function autoMapCommand(ctx: BotContext): Promise<void> {
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
  const clientId = parts[1] ? parts[1].trim() : undefined;

  const snap = cache.getFresh();
  if (!snap) {
    await ctx.reply(formatError('No fresh inventory cached. Use /prtg_inventory refresh to fetch.'));
    return;
  }

  const result = mappingService.previewAutoMapping(context, snap, clientId);

  const { token, preview } = result;

  const lines: string[] = [
    '🤖 <b>AUTO-MAPPING PREVIEW</b>',
    '',
  ];

  if (preview.automatic.length > 0) {
    lines.push(`<b>✅ Automatic (${preview.automatic.length}):</b>`);
    for (const a of preview.automatic.slice(0, 10)) {
      lines.push(`  <code>#${a.objectId}</code> → ${htmlEscape(a.clientId)} ${htmlEscape(a.name)} (${Math.round(a.confidence * 100)}%)`);
    }
    if (preview.automatic.length > 10) {
      lines.push(`  ... and ${preview.automatic.length - 10} more`);
    }
    lines.push('');
  }

  if (preview.suggestions.length > 0) {
    lines.push(`<b>💡 Suggestions (${preview.suggestions.length} customers):</b>`);
    for (const s of preview.suggestions.slice(0, 5)) {
      lines.push(`  ${htmlEscape(s.clientId)} ${htmlEscape(s.name)}: ${s.candidates.length} candidates`);
    }
    if (preview.suggestions.length > 5) {
      lines.push(`  ... and ${preview.suggestions.length - 5} more`);
    }
    lines.push('');
  }

  if (preview.unresolved.length > 0) {
    lines.push(`<b>❓ Unresolved (${preview.unresolved.length} customers):</b>`);
    for (const u of preview.unresolved.slice(0, 5)) {
      lines.push(`  ${htmlEscape(u.clientId)} ${htmlEscape(u.name)} — ${htmlEscape(u.reason)}`);
    }
    if (preview.unresolved.length > 5) {
      lines.push(`  ... and ${preview.unresolved.length - 5} more`);
    }
    lines.push('');
  }

  if (preview.automatic.length === 0) {
    lines.push('<i>No automatic mappings available. Use /map_client for manual mapping.</i>');
  }

  const keyboard = createConfirmAutoMappingKeyboard(token);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}