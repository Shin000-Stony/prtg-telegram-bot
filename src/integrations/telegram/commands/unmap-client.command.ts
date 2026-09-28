import type { BotContext } from '@/integrations/telegram/bot';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { mappingService } from '@/modules/mapping/mapping.service';
import { createConfirmUnmapKeyboard } from '@/integrations/telegram/ui/cards';
import { formatError, formatAccessDenied, htmlEscape } from '@/integrations/telegram/ui/messages';

export async function unmapClientCommand(ctx: BotContext): Promise<void> {
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
  if (parts.length < 2) {
    await ctx.reply(formatError('Usage: /unmap_client <client_id>'));
    return;
  }

  const clientId = parts[1];

  const customer = customerService.getByClientId(clientId);
  if (!customer) {
    await ctx.reply(formatError('Customer not found'));
    return;
  }

  const mapping = mappingService.getByCustomerId(customer.id);
  if (!mapping) {
    await ctx.reply(formatError('Customer has no mapping to remove'));
    return;
  }

  const preview = mappingService.prepareUnmap(clientId, context);

  const lines = [
    `🗑 <b>CONFIRM UNMAP</b>`,
    `Customer  : ${htmlEscape(preview.preview.customer.name)} (${htmlEscape(preview.preview.customer.clientId)})`,
    `Sensor    : <code>#${preview.preview.mapping.prtgObjectId}</code> — ${htmlEscape(preview.preview.mapping.prtgDeviceName || 'N/A')} — ${htmlEscape(preview.preview.mapping.prtgSensorName || 'N/A')}`,
    `Method    : ${preview.preview.mapping.mappingMethod}`,
    `Verified  : ${preview.preview.mapping.verified ? 'Yes' : 'No'}`,
    '',
    'This will permanently remove the mapping.',
  ];

  const keyboard = createConfirmUnmapKeyboard(preview.token);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}