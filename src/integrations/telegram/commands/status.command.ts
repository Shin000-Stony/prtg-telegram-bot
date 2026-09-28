import type { BotContext } from '@/integrations/telegram/bot';
import { statusService } from '@/modules/status/status.service';
import { accessService } from '@/modules/groups/access.service';
import { formatAccessDenied, htmlEscape, parsePositiveInteger } from '@/integrations/telegram/ui/messages';
import { formatTimestamp } from '@/integrations/telegram/ui/formatter';
import type { StatusDetail, DownItem } from '@/modules/status/status.types';

const STATUS_ICON: Record<StatusDetail['status'], string> = {
  UP: '🟢',
  DOWN: '🔴',
  UNKNOWN: '🟡',
  UNMAPPED: '⚪',
  DISABLED: '⚫',
  PIC_MANAGED: '📋',
  NOT_CHECKED: '⏳',
  WARNING: '🟡',
  UNUSUAL: '🟠',
  PAUSED: '⏸️',
};

const STATUS_LABEL: Record<StatusDetail['status'], string> = {
  UP: 'UP',
  DOWN: 'DOWN',
  WARNING: 'WARNING',
  UNUSUAL: 'UNUSUAL',
  PAUSED: 'PAUSED',
  UNKNOWN: 'UNKNOWN',
  UNMAPPED: 'UNMAPPED',
  DISABLED: 'DISABLED',
  PIC_MANAGED: 'PIC-managed',
  NOT_CHECKED: 'NOT CHECKED',
};

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export async function statusCommand(ctx: BotContext): Promise<void> {
  const context = {
    userId: ctx.userId || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'private',
  };

  if (!context.userId || !context.chatId) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  if (!ctx.message || !('text' in ctx.message)) return;

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length !== 2) {
    await ctx.reply('ℹ️ Usage: /status <client_id>');
    return;
  }

  const clientId = parts[1].trim();
  const detail = statusService.getCustomerStatus(context, clientId);

  if (isDeniedStatus(detail)) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  await ctx.reply(formatStatusCard(detail), { parse_mode: 'HTML' });
}

export async function summaryCommand(ctx: BotContext): Promise<void> {
  const context = {
    userId: ctx.userId || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'private',
  };

  if (!context.userId || !context.chatId) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  const scope = accessService.getCustomerAccessScope(context);
  if (scope.kind === 'none') {
    await ctx.reply(formatAccessDenied());
    return;
  }

  const summary = statusService.getSummary(context);

  await ctx.reply(formatSummaryCard(summary), { parse_mode: 'HTML' });
}

export async function downCommand(ctx: BotContext): Promise<void> {
  const context = {
    userId: ctx.userId || '',
    chatId: ctx.chatId || '',
    chatType: ctx.chatType || 'private',
  };

  if (!context.userId || !context.chatId) {
    await ctx.reply(formatAccessDenied());
    return;
  }

  if (!ctx.message || !('text' in ctx.message) || ctx.message.text === undefined) {
    await ctx.reply('ℹ️ Usage: /down [page]');
    return;
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length > 2) {
    await ctx.reply('❌ Too many arguments. Usage: /down [page]');
    return;
  }

  let page = 1;
  if (parts.length === 2) {
    const parsed = parsePositiveInteger(parts[1]);
    if (parsed === null) {
      await ctx.reply('❌ Invalid page number. Use a positive integer.');
      return;
    }
    page = parsed;
  }

  const scope = accessService.getCustomerAccessScope(context);
  if (scope.kind === 'none') {
    await ctx.reply(formatAccessDenied());
    return;
  }

  const result = statusService.listDown(context, page);

  const chunks = formatDownList(result);
  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: 'HTML' });
  }
}

function isDeniedStatus(detail: StatusDetail): boolean {
  return detail.customer.id === 0 && detail.customer.clientId === '';
}

export function formatStatusCard(detail: StatusDetail): string {
  const icon = STATUS_ICON[detail.status];
  const label = STATUS_LABEL[detail.status];

  const lines = [
    `<b>${icon} ${label}</b>`,
    '',
    `<b>${htmlEscape(detail.customer.name)}</b>`,
    `Client ID : <code>${htmlEscape(detail.customer.clientId)}</code>`,
  ];

  if (detail.mapping) {
    lines.push('');
    if (detail.status === 'UNMAPPED' || !detail.mapping) {
      lines.push(`Mapping    : Not connected to a PRTG sensor`);
    } else {
      lines.push(`Source     : PRTG — ${htmlEscape(detail.mapping.prtgDeviceName || '—')}`);
    }

    if (detail.status !== 'DISABLED' && detail.status !== 'PIC_MANAGED' && detail.status !== 'NOT_CHECKED' && detail.dataQuality !== 'not_applicable') {
      if (detail.mapping.prtgSensorName) {
        lines.push(`Sensor     : ${htmlEscape(detail.mapping.prtgSensorName)} — #${detail.mapping.prtgObjectId}`);
      }
    }
  } else {
    if (detail.customer.monitorType === 'icmp') {
      lines.push('');
      lines.push(`Source     : ICMP`);
    } else if (detail.status !== 'UNMAPPED') {
      lines.push('');
      lines.push(`Source     : ${detail.customer.monitorType.toUpperCase()}`);
    }
  }

  if (detail.autoUnverified && detail.mapping) {
    lines.push(`<i>(AUTO — not yet verified)</i>`);
  }

  if (detail.dataQuality === 'unavailable' || detail.dataQuality === 'not_applicable') {
    if (detail.status === 'UNMAPPED') {
      lines.push('');
      lines.push('Data       : Not applicable (not connected)');
    } else if (detail.status === 'DISABLED') {
      lines.push('');
      lines.push('Data       : Not applicable (disabled)');
    } else if (detail.status === 'PIC_MANAGED') {
      lines.push('');
      lines.push('Data       : Not applicable (PIC-managed)');
    } else if (detail.status === 'NOT_CHECKED') {
      lines.push('');
      lines.push('Data       : Unavailable');
    }
  } else if (detail.dataQuality === 'stale') {
    lines.push('');
    lines.push('Data       : Stale');
  } else if (detail.dataQuality === 'fresh') {
    lines.push('');
    lines.push('Data       : Fresh');
  }

  if (detail.fetchedAt && detail.dataQuality !== 'unavailable' && detail.dataQuality !== 'not_applicable') {
    lines.push(`Fetched at : ${formatTimestamp(detail.fetchedAt)} WITA`);
  } else if (detail.dataQuality === 'unavailable') {
    lines.push(`Last checked : —`);
  }

  if (detail.dataQuality === 'stale' && detail.lastKnownStatus) {
    const lastIcon = STATUS_ICON[detail.lastKnownStatus];
    const lastLabel = STATUS_LABEL[detail.lastKnownStatus];
    lines.push(`<i>Last known status: ${lastIcon} ${lastLabel}</i>`);
  }

  if (detail.reason === 'down_acknowledged' || detail.reason === 'down_partial') {
    lines.push('');
    lines.push('<i>(acknowledged)</i>');
  }

  return lines.join('\n');
}

export function formatStatusBrief(detail: StatusDetail): string {
  const icon = STATUS_ICON[detail.status];
  const label = STATUS_LABEL[detail.status];
  let line = `<i>${icon} ${label}</i>`;
  if (detail.fetchedAt && detail.dataQuality !== 'unavailable' && detail.dataQuality !== 'not_applicable') {
    line += ` — <i>${formatTimestamp(detail.fetchedAt)} WITA</i>`;
  }
  return line;
}

export function formatSummaryCard(summary: { total: number; buckets: Array<{ status: string; count: number }>; dataQuality: Record<string, number>; fetchedAt: string | null }): string {
  const lines = [
    '📊 <b>SUMMARY</b>',
    '',
    `Total Customers: ${summary.total}`,
    '',
  ];

  const bucketOrder: StatusDetail['status'][] = ['UP', 'DOWN', 'WARNING', 'UNUSUAL', 'PAUSED', 'UNKNOWN', 'UNMAPPED', 'DISABLED', 'PIC_MANAGED', 'NOT_CHECKED'];
  const statusMap = new Map<string, number>();
  for (const b of summary.buckets) {
    statusMap.set(b.status, b.count);
  }

  for (const status of bucketOrder) {
    if (statusMap.has(status)) {
      const icon = STATUS_ICON[status];
      const label = STATUS_LABEL[status];
      lines.push(`${icon} ${label} : ${statusMap.get(status)}`);
    }
  }
  for (const b of summary.buckets) {
    if (!bucketOrder.includes(b.status as StatusDetail['status'])) {
      const icon = STATUS_ICON[b.status as keyof typeof STATUS_ICON] || '❓';
      lines.push(`${icon} ${b.status} : ${b.count}`);
    }
  }

  if (summary.fetchedAt) {
    lines.push('', `<i>${formatTimestamp(summary.fetchedAt)} WITA</i>`);
  } else {
    lines.push('', '<i>Data unavailable</i>');
  }

  const dataQualityParts = [
    `fresh=${summary.dataQuality.fresh}`,
    `stale=${summary.dataQuality.stale}`,
    `unavailable=${summary.dataQuality.unavailable}`,
    `N/A=${summary.dataQuality.notApplicable}`,
  ];
  lines.push(`Data quality: ${dataQualityParts.join(', ')}`);

  let needsAttention = 0;
  for (const b of summary.buckets) {
    if (['DOWN', 'WARNING', 'UNUSUAL', 'UNKNOWN', 'UNMAPPED'].includes(b.status)) {
      needsAttention += b.count;
    }
  }
  if (needsAttention > 0) {
    lines.push('', `<i>${needsAttention} customer(s) need attention. Use /down for details.</i>`);
  }

  return lines.join('\n');
}

function truncate(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen - 1) + '…';
}

export function formatDownList(result: { items: DownItem[]; total: number; page: number; totalPages: number; fetchedAt: string | null; dataQuality: string; uncertainCount: number; pageOutOfRange: boolean }): string[] {
  if (result.pageOutOfRange) {
    let msg = '🔴 <b>DOWN CUSTOMERS</b>\n\n';
    msg += `❌ Page ${result.page} is out of range. Valid range: 1-${result.totalPages}.`;
    if (result.fetchedAt) {
      msg += `\n\n<i>${formatTimestamp(result.fetchedAt)} WITA</i>`;
    }
    return [msg];
  }

  if (result.total === 0 && result.uncertainCount === 0) {
    let msg = '📋 <b>DOWN CUSTOMERS</b>\n\n';
    msg += 'No confirmed DOWN customers on fresh data.';
    if (result.fetchedAt) {
      msg += `\n\n<i>${formatTimestamp(result.fetchedAt)} WITA</i>`;
    } else {
      msg += '\n\n<i>Data unavailable. Ask admin to run /prtg_inventory refresh.</i>';
    }
    return [msg];
  }

  let header = '🔴 <b>DOWN CUSTOMERS</b>\n\n';
  header += `Page ${result.page}/${result.totalPages} (${result.total} total)`;
  if (result.uncertainCount > 0) {
    header += `\n\n⚠️ Status unavailable or uncertain for ${result.uncertainCount} customer(s).`;
  }
  if (result.total === 0) {
    header += '\n\nNo confirmed DOWN customers on fresh data.';
  }

  const chunks: string[] = [];
  let current = header + '\n\n';

  for (const item of result.items) {
    let line = `<code>${htmlEscape(item.clientId)}</code> — ${htmlEscape(truncate(item.customerName, 100))}`;
    line += `\n  #<code>${item.objectId}</code> — ${item.deviceName ? htmlEscape(truncate(item.deviceName, 50)) : '—'} — ${item.sensorName ? htmlEscape(truncate(item.sensorName, 50)) : '—'}`;
    line += `\n  Last value : ${item.lastValue ? htmlEscape(truncate(item.lastValue, 100)) : '—'}`;

    if (current.length + line.length + 1 > TELEGRAM_MAX_MESSAGE_LENGTH) {
      chunks.push(current.trimEnd());
      current = line + '\n';
    } else {
      current += line + '\n';
    }
  }

  if (result.fetchedAt) {
    current += `\n<i>${formatTimestamp(result.fetchedAt)} WITA</i>`;
  } else {
    current += '\n<i>Data unavailable. Ask admin to run /prtg_inventory refresh.</i>';
  }

  if (result.totalPages > 1) {
    current += '\n\nNavigate: /down &lt;page&gt;';
  }

  chunks.push(current.trimEnd());

  return chunks;
}
