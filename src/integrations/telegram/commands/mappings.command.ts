import type { BotContext } from '@/integrations/telegram/bot';
import { accessService } from '@/modules/groups/access.service';
import { mappingService } from '@/modules/mapping/mapping.service';
import { formatAccessDenied, formatInfo, htmlEscape } from '@/integrations/telegram/ui/messages';

export async function mappingsCommand(ctx: BotContext): Promise<void> {
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

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.trim().split(/\s+/);
  const page = parts[1] ? Math.max(1, parseInt(parts[1], 10)) : 1;
  const pageSize = 20;

  const allMappings = mappingService.getAllWithDetails();
  const total = allMappings.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const pageMappings = allMappings.slice(start, start + pageSize);

  if (pageMappings.length === 0) {
    await ctx.reply(formatInfo('No mappings found.'));
    return;
  }

  const lines = [
    `📋 <b>PRTG MAPPINGS</b> (Page ${page}/${totalPages}, Total: ${total})`,
    '',
  ];

  for (const m of pageMappings) {
    const methodLabel = m.mappingMethod === 'auto' ? '🤖 Auto' : m.mappingMethod === 'manual' ? '👤 Manual' : '📥 Import';
    const verifiedLabel = m.verified ? '✅ Verified' : '⏳ Pending';
    lines.push(
      `<code>#${m.clientId}</code> ${htmlEscape(m.customerName)} → ` +
      `<code>#${m.prtgObjectId}</code> (${methodLabel}, ${verifiedLabel})`
    );
  }

  if (totalPages > 1) {
    lines.push('', `<i>Page ${page}/${totalPages} — Use /mappings &lt;page&gt; to navigate</i>`);
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}