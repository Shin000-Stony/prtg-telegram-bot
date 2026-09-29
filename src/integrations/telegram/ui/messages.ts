import type { MappingCandidate } from '@/modules/mapping/mapping.types';
import type { StatusDetail } from '@/modules/status/status.types';

import { formatTimestamp } from '@/integrations/telegram/ui/formatter';

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

const CATEGORY_ICON: Record<string, string> = {
  'Daily Monitoring': '📊',
  'Customers': '👥',
  'Groups & Alerts': '🔔',
  'PRTG Mapping': '🔗',
  'Utilities': '🧰',
};

const SEPARATOR = '────────';

export function formatChatInfo(chatId: string, chatType: string): string {
  return [
    '🤖 <b>CHAT INFORMATION</b>',
    '',
    `Chat ID : <code>${chatId}</code>`,
    `Type    : ${chatType}`,
  ].join('\n');
}

export function formatHelpMessage(
  categories: Array<{ title: string; commands: Array<{ command: string; description: string }> }>,
  subtitle?: string,
): string {
  const lines = ['<b>PRTG Monitor · Help</b>', 'Tap a command to run it, or copy it to add details.'];

  if (subtitle) {
    lines.push(htmlEscape(subtitle));
  }

  const visible = categories.filter((c) => c.commands.length > 0);

  for (let i = 0; i < visible.length; i++) {
    lines.push(SEPARATOR);
    const icon = CATEGORY_ICON[visible[i].title] ?? '•';
    lines.push(`${icon} <b>${htmlEscape(visible[i].title)}</b>`);
    for (const cmd of visible[i].commands) {
      const parts = cmd.command.split(' ');
      const cmdName = `<b>/${htmlEscape(parts[0])}</b>`;
      const argText = parts.length > 1 ? ` <code>&lt;${htmlEscape(parts.slice(1).join(' '))}&gt;</code>` : '';
      lines.push(`${cmdName}${argText} — ${htmlEscape(cmd.description)}`);
    }
  }

  lines.push(SEPARATOR);
  lines.push('<i>Status is read from monitoring results. ICMP and polling engine are admin-controlled (V6).</i>');

  return lines.join('\n');
}

export function formatCustomerEntry(d: StatusDetail): string {
  const icon = STATUS_ICON[d.status];
  const label = STATUS_LABEL[d.status];
  const isDisabled = d.status === 'DISABLED';

  let statusLabel = label;
  if (d.status === 'UNKNOWN' && d.dataQuality === 'stale') {
    statusLabel = 'UNKNOWN (stale data)';
  } else if (d.status === 'UNKNOWN' && d.dataQuality === 'unavailable') {
    statusLabel = 'UNKNOWN (unavailable)';
  }

  const lines = [
    `<b>${icon} ${statusLabel}</b> · <code>${htmlEscape(d.customer.clientId)}</code>`,
    htmlEscape(d.customer.name),
  ];

  const monitorType = d.customer.monitorType.toUpperCase();
  const monitoring = isDisabled ? 'Disabled' : 'Enabled';
  lines.push(`Type: ${monitorType} · Monitoring: ${monitoring}`);

  if (d.customer.monitorType === 'prtg') {
    if (d.mapping) {
      const verifiedLabel = d.mapping.verified ? 'Verified' : 'Unverified';
      const suffix = isDisabled ? ' (not in use)' : '';
      lines.push(`Mapping: #${d.mapping.prtgObjectId} · ${verifiedLabel}${suffix}`);
    } else {
      lines.push('Mapping: Unmapped');
    }
  }

  return lines.join('\n');
}

export function formatCustomerList(details: StatusDetail[]): string {
  if (details.length === 0) {
    return '📋 <b>Customers</b>\n\nNo visible customers found.';
  }

  const lines = ['📋 <b>Customers</b>', ''];

  for (const d of details) {
    lines.push(formatCustomerEntry(d));
    lines.push('');
  }

  lines.push('View details: <b>/client</b> <code>&lt;client_id&gt;</code>');

  return lines.join('\n');
}

export function formatCustomerListPage(details: StatusDetail[], page: number, total: number, totalPages: number): string {
  const start = (page - 1) * 8 + 1;
  const end = start + details.length - 1;

  if (details.length === 0) {
    return '<b>Customers</b>\n\nNo visible customers found.';
  }

  const lines = ['<b>Customers</b>'];
  lines.push(`Showing ${start}–${end} of ${total} · Page ${page}/${totalPages}`);

  for (let i = 0; i < details.length; i++) {
    lines.push(SEPARATOR);
    lines.push(formatCustomerEntry(details[i]));
  }

  lines.push(SEPARATOR);
  lines.push(`View details: <b>/client</b> <code>&lt;client_id&gt;</code>`);
  lines.push(`Search: <b>/clients</b> <code>&lt;keyword&gt;</code>`);

  return lines.join('\n');
}

export function formatCustomerSearchPage(keyword: string, details: StatusDetail[], page: number, total: number, totalPages: number): string {
  const start = (page - 1) * 8 + 1;
  const end = start + details.length - 1;

  if (total === 0) {
    return '<b>Customers</b>\n'
      + `Search: <code>${htmlEscape(keyword)}</code>\n`
      + 'No customers match your search.\n'
      + 'Try a shorter keyword or check the Client ID.\n'
      + '\n'
      + `All customers: <b>/clients</b>`;
  }

  const lines = ['<b>Customers</b>'];
  lines.push(`Search: <code>${htmlEscape(keyword)}</code>`);
  lines.push(`Showing ${start}–${end} of ${total} matches · Page ${page}/${totalPages}`);

  for (let i = 0; i < details.length; i++) {
    lines.push(SEPARATOR);
    lines.push(formatCustomerEntry(details[i]));
  }

  lines.push(SEPARATOR);
  lines.push(`View details: <b>/client</b> <code>&lt;client_id&gt;</code>`);
  lines.push(`All customers: <b>/clients</b>`);

  return lines.join('\n');
}

export function formatExpiredPagination(): string {
  return 'This list has expired. Send <b>/clients</b> again.';
}

export function formatCustomerDetail(customer: {
  id: number;
  clientId: string;
  name: string;
  monitorType: string;
  pingHost: string | null;
  enabled: boolean;
  createdAt: string;
  prtgMapping?: { objectId: number; deviceName: string | null; sensorName: string | null; verified: boolean } | null;
}): string {
  const lines = [
    '🖥 <b>CUSTOMER DETAIL</b>',
    '',
    `Client ID  : <code>${customer.clientId}</code>`,
    `Name       : ${customer.name}`,
    `Monitor    : ${customer.monitorType.toUpperCase()}`,
  ];

  if (customer.pingHost) {
    lines.splice(4, 0, `Host       : ${customer.pingHost}`);
  }

  lines.push(
    `Monitoring : ${customer.enabled ? 'Enabled' : 'Disabled'}`,
    `Created    : ${formatTimestamp(customer.createdAt)} WITA`,
  );

  if (customer.prtgMapping) {
    lines.push(`Mapping    : #${customer.prtgMapping.objectId} ${customer.prtgMapping.deviceName || '—'} — ${customer.prtgMapping.sensorName || '—'} ${customer.prtgMapping.verified ? '✅ Verified' : '⏳ Unverified'}`);
  } else {
    lines.push(`Mapping    : Not connected`);
  }

  return lines.join('\n');
}

export function formatGroupInfo(group: { chatId: string; title: string | null; enabled: boolean; registeredAt: string }): string {
  return [
    '👥 <b>GROUP INFORMATION</b>',
    '',
    `Chat ID    : <code>${group.chatId}</code>`,
    `Title      : ${group.title || 'N/A'}`,
    `Status     : ${group.enabled ? '🟢 Enabled' : '🔴 Disabled'}`,
    `Registered : ${group.registeredAt}`,
  ].join('\n');
}

export function formatMappingCandidates(candidates: MappingCandidate[]): string {
  if (candidates.length === 0) {
    return 'No matching PRTG sensors found.';
  }

  const lines = ['🔍 <b>Suggested PRTG Objects</b>', ''];

  for (const c of candidates) {
    const scorePct = Math.round(c.confidence * 100);
    lines.push(`#<code>${c.prtgObjectId}</code> — ${c.deviceName} — ${c.sensorName} (${c.sensorType})`);
    lines.push(`  Match score: ${scorePct}% — ${c.matchReason}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatCsvPreview(
  fileName: string,
  summary: { totalRows: number; validCount: number; errorCount: number; newCount: number; duplicateInCsv: number; existingInDb: number },
  errors: Array<{ rowNumber: number; field: string; message: string; value: string }>,
  previewRows: Array<{ clientId: string; name: string; monitorType: string }>
): string {
  const lines = [
    '📥 <b>CSV IMPORT PREVIEW</b>',
    '',
    `File       : ${fileName}`,
    `Rows       : ${summary.totalRows}`,
    `Valid      : ${summary.validCount}`,
    `Invalid    : ${summary.errorCount}`,
    `Duplicates : ${summary.duplicateInCsv}`,
    `New        : ${summary.newCount}`,
    '',
    'Preview:',
  ];

  for (const row of previewRows) {
    lines.push(`#${row.clientId} ${row.name} — ${row.monitorType.toUpperCase()}`);
  }

  lines.push('', 'No data has been written yet.');

  if (errors.length > 0) {
    lines.push('', '<b>Errors:</b>');
    for (const err of errors.slice(0, 10)) {
      lines.push(`Row ${err.rowNumber}: ${err.field} — ${err.message}`);
    }
    if (errors.length > 10) {
      lines.push(`... and ${errors.length - 10} more errors`);
    }
  }

  return lines.join('\n');
}

export function formatCsvImportResult(result: { imported: number; skipped: number; errors: Array<{ rowNumber: number; message: string }> }): string {
  const lines = [
    '✅ <b>IMPORT COMPLETED</b>',
    '',
    `Imported: ${result.imported}`,
    `Skipped: ${result.skipped}`,
    `Errors: ${result.errors.length}`,
  ];

  if (result.errors.length > 0) {
    lines.push('', '<b>Errors:</b>');
    for (const err of result.errors.slice(0, 10)) {
      lines.push(`Row ${err.rowNumber}: ${err.message}`);
    }
    if (result.errors.length > 10) {
      lines.push(`... and ${result.errors.length - 10} more errors`);
    }
  }

  return lines.join('\n');
}

export function formatGroupRegistered(group: { chatId: string; title: string | null }): string {
  return [
    '✅ <b>GROUP REGISTERED</b>',
    '',
    `Chat ID  : <code>${group.chatId}</code>`,
    `Title    : ${group.title || 'N/A'}`,
  ].join('\n');
}

export function formatGroupAlreadyRegistered(group: { chatId: string; title: string | null }): string {
  return [
    'ℹ️ <b>GROUP ALREADY REGISTERED</b>',
    '',
    `Chat ID  : <code>${group.chatId}</code>`,
    `Title    : ${group.title || 'N/A'}`,
  ].join('\n');
}

export function formatUnregisterConfirm(group: { chatId: string; title: string | null }): string {
  return [
    '⚠️ <b>UNREGISTER GROUP</b>',
    '',
    `Chat ID  : <code>${group.chatId}</code>`,
    `Title    : ${group.title || 'N/A'}`,
    '',
    'This will remove the group registration and all customer assignments.',
    'Alert subscriptions will be removed.',
    '',
    'Are you sure?',
  ].join('\n');
}

export function formatGroupUnregistered(group: { chatId: string; title: string | null }): string {
  return [
    '✅ <b>GROUP UNREGISTERED</b>',
    '',
    `Chat ID  : <code>${group.chatId}</code>`,
    `Title    : ${group.title || 'N/A'}`,
  ].join('\n');
}

export function formatGroupNotRegistered(): string {
  return 'ℹ️ This group is not registered.';
}

export function formatGlobalGroupNoRegistration(): string {
  return 'ℹ️ Global Group does not need registration. It has automatic access to all customers.';
}

export function formatClientAssigned(customer: { clientId: string; name: string }): string {
  return [
    '✅ <b>CLIENT ASSIGNED</b>',
    '',
    `Client ID : <code>${customer.clientId}</code>`,
    `Name      : ${customer.name}`,
    'Visibility: Visible',
    'Alerts    : OFF (use <b>/group_alerts</b> <code>&lt;client_id&gt;</code> on to enable)',
  ].join('\n');
}

export function formatClientUnassigned(customer: { clientId: string; name: string }, receiveAlerts: boolean): string {
  const lines = [
    '✅ <b>CLIENT UNASSIGNED</b>',
    '',
    `Client ID : <code>${customer.clientId}</code>`,
    `Name      : ${customer.name}`,
  ];

  if (receiveAlerts) {
    lines.push('', 'Client is hidden. Alert subscription remains ON.');
    lines.push('Use <b>/group_alerts</b> <code>&lt;client_id&gt;</code> off to disable alerts.');
  }

  return lines.join('\n');
}

export function formatAlertEnabled(customer: { clientId: string; name: string }, isGlobalGroup: boolean): string {
  const lines = [
    '✅ <b>ALERT SUBSCRIPTION ENABLED</b>',
    '',
    `Client ID : <code>${customer.clientId}</code>`,
    `Name      : ${customer.name}`,
  ];

  if (isGlobalGroup) {
    lines.push('Alerts    : ON');
  } else {
    lines.push('Visibility: Visible');
    lines.push('Alerts    : ON');
  }

  return lines.join('\n');
}

export function formatAlertDisabled(customer: { clientId: string; name: string }, isGlobalGroup: boolean): string {
  const lines = [
    '✅ <b>ALERT SUBSCRIPTION DISABLED</b>',
    '',
    `Client ID : <code>${customer.clientId}</code>`,
    `Name      : ${customer.name}`,
  ];

  if (isGlobalGroup) {
    lines.push('Alerts    : OFF');
  } else {
    lines.push('Visibility: Visible');
    lines.push('Alerts    : OFF');
  }

  return lines.join('\n');
}

export function formatAssignFirst(): string {
  return [
    '⚠️ <b>ASSIGN CUSTOMER FIRST</b>',
    '',
    'This customer is not visible in this group.',
    'Assign the customer first:',
    '<b>/assign_client</b> <code>&lt;client_id&gt;</code>',
  ].join('\n');
}

export function formatGroupClientsHeader(groupType: string): string {
  const headers: Record<string, string> = {
    global: '👥 <b>GLOBAL GROUP — CUSTOMERS</b>',
    ordinary: '👥 <b>GROUP — CUSTOMERS</b>',
  };
  return headers[groupType] || '👥 <b>GROUP — CUSTOMERS</b>';
}

export function formatClientLine(client: { clientId: string; name: string; canView: boolean; receiveAlerts: boolean }): string {
  const visibility = client.canView ? '👁 Visible' : '🚫 Hidden';
  const alerts = client.receiveAlerts ? '🔔 Alerts ON' : '🔕 Alerts OFF';
  return `#${client.clientId} ${client.name}\n  ${visibility} | ${alerts}`;
}

export function formatNoClients(): string {
  return 'ℹ️ No customers assigned to this group.';
}

export function formatNotRegistered(isAdmin: boolean): string {
  if (isAdmin) {
    return '⚠️ This group is not registered.\nRun <b>/register_group</b> to register this group.';
  }
  return '❌ This group is not registered. Ask an admin to run <b>/register_group</b>.';
}

export function formatGlobalGroupNoUnregister(): string {
  return 'ℹ️ Global Group cannot be unregistered. It is configured via TELEGRAM_GLOBAL_GROUP_ID.';
}

export function formatGlobalGroupNoAssignment(): string {
  return 'ℹ️ Global Group has automatic access to all customers. Assignment is not required.';
}

export function formatGlobalGroupNoUnassign(): string {
  return 'ℹ️ Global Group cannot hide customers. Use <b>/group_alerts</b> <code>&lt;client_id&gt;</code> off to disable alerts for specific customers.';
}

export function formatGlobalGroupAlertEnabled(): string {
  return '✅ Alert subscription enabled for Global Group.';
}

export function formatGlobalGroupAlertDisabled(): string {
  return '✅ Alert subscription disabled for Global Group.';
}

export function formatDeleteClientPreview(
  customer: { clientId: string; name: string },
  counts: {
    groups: number;
    mappings: number;
    alerts: number;
  },
): string {
  return [
    '⚠️ <b>DELETE CUSTOMER</b>',
    '',
    `Client ID  : <code>${customer.clientId}</code>`,
    `Name       : ${customer.name}`,
    '',
    SEPARATOR,
    'The following data will be removed:',
    `· ${counts.mappings} PRTG mapping(s)`,
    `· ${counts.groups} group access assignment(s)`,
    `· ${counts.alerts} pending/sending alert(s) (cancelled + removed)`,
    `· All alert outbox history (CASCADE)`,
    `· 1 monitoring state record`,
    '· 1 customer record',
    SEPARATOR,
    '',
    'Pending and sending alerts will be cancelled. Already-delivered Telegram messages cannot be recalled.',
    'This action cannot be undone.',
  ].join('\n');
}

export function formatDeleteClientSuccess(customer: { clientId: string; name: string }): string {
  return [
    '✅ <b>CUSTOMER DELETED</b>',
    '',
    `Client ID : <code>${customer.clientId}</code>`,
    `Name      : ${customer.name}`,
  ].join('\n');
}

export function formatDeleteClientCancelled(): string {
  return '❌ Deletion cancelled.';
}

export function formatError(message: string): string {
  return `❌ ${message}`;
}

export function formatSuccess(message: string): string {
  return `✅ ${message}`;
}

export function formatWarning(message: string): string {
  return `⚠️ ${message}`;
}

export function formatInfo(message: string): string {
  return `ℹ️ ${message}`;
}

export function formatAccessDenied(message?: string): string {
  return `❌ ${message || 'Access denied. This command requires admin privileges in private chat or global group.'}`;
}

export function formatValidationError(message: string): string {
  return `❌ ${message}`;
}

export function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function parsePositiveInteger(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const num = Number(value);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}
