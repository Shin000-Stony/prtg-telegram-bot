import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'telegraf/types';
import { parsePositiveInteger } from '@/integrations/telegram/ui/messages';

export function createMappingKeyboard(sessionId: string, customerId: number, objectIds: number[]): InlineKeyboardMarkup {
  const buttons: InlineKeyboardButton[][] = [];

  for (const objectId of objectIds.slice(0, 5)) {
    buttons.push([
      {
        text: `📌 Map #${objectId}`,
        callback_data: `map:${sessionId}:${customerId}:${objectId}`,
      },
    ]);
  }

  if (objectIds.length > 5) {
    buttons.push([
      {
        text: '🔍 Search other objects',
        callback_data: `map_search:${sessionId}:${customerId}`,
      },
    ]);
  }

  buttons.push([
    {
      text: '❌ Cancel',
      callback_data: `map_cancel:${sessionId}:${customerId}`,
    },
  ]);

  return { inline_keyboard: buttons };
}

export function createConfirmMappingKeyboard(token: string, customerId: number, objectId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Confirm', callback_data: `map_confirm:${token}:${customerId}:${objectId}` },
        { text: '❌ Cancel', callback_data: `map_cancel:${token}:${customerId}` },
      ],
    ],
  };
}

export function createVerifyMappingKeyboard(sessionId: string, customerId: number, objectId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Verify Mapping', callback_data: `map_verify:${sessionId}:${customerId}:${objectId}` },
      ],
    ],
  };
}

export function parseMappingCallback(data: string): { action: string; token: string; customerId: number; objectId?: number } | null {
  const parts = data.split(':');
  if (parts.length < 3) return null;

  const action = parts[0];
  const token = parts[1];
  const customerId = parsePositiveInteger(parts[2]);
  if (customerId === null) return null;

  const objectId = parts[3] ? parsePositiveInteger(parts[3]) : undefined;
  if (objectId !== undefined && objectId === null) return null;

  return { action, token, customerId: customerId!, objectId: objectId ?? undefined };
}

export function buildMappingCallback(action: string, customerId: number, objectId?: number): string {
  const parts = [action, String(customerId)];
  if (objectId !== undefined) {
    parts.push(String(objectId));
  }
  return parts.join(':');
}

export function createCsvConfirmKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Confirm Import', callback_data: `csv_confirm:${token}` },
        { text: '❌ Cancel', callback_data: `csv_cancel:${token}` },
      ],
    ],
  };
}

export function parseCsvCallback(data: string): { action: string; token: string } | null {
  const parts = data.split(':');
  if (parts.length !== 2) return null;
  return { action: parts[0], token: parts[1] };
}

export function createUnregisterConfirmKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Yes, Unregister', callback_data: `group_unregister_confirm:${token}` },
        { text: '❌ Cancel', callback_data: `group_unregister_cancel:${token}` },
      ],
    ],
  };
}

export function parseUnregisterCallback(data: string): { action: string; token: string } | null {
  const parts = data.split(':');
  if (parts.length !== 2) return null;
  const action = parts[0];
  // Normalize action names
  if (action === 'group_unregister_confirm') return { action: 'confirm', token: parts[1] };
  if (action === 'group_unregister_cancel') return { action: 'cancel', token: parts[1] };
  return null;
}

export function createDeleteConfirmKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Yes, Delete', callback_data: `delete_confirm:${token}` },
        { text: '❌ Cancel', callback_data: `delete_cancel:${token}` },
      ],
    ],
  };
}

export function parseDeleteCallback(data: string): { action: string; token: string } | null {
  const parts = data.split(':');
  if (parts.length !== 2) return null;
  const action = parts[0];
  if (action === 'delete_confirm') return { action: 'confirm', token: parts[1] };
  if (action === 'delete_cancel') return { action: 'cancel', token: parts[1] };
  return null;
}

export function createConfirmAutoMappingKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Apply Auto-Mappings', callback_data: `auto_apply:${token}` },
        { text: '❌ Cancel', callback_data: `auto_cancel:${token}` },
      ],
    ],
  };
}

export function createConfirmUnmapKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Yes, Unmap', callback_data: `unmap_confirm:${token}` },
        { text: '❌ Cancel', callback_data: `unmap_cancel:${token}` },
      ],
    ],
  };
}

export function createSearchKeyboard(sessionId: string, customerId: number, objectIds: number[], page: number = 1, totalPages?: number): InlineKeyboardMarkup {
  const buttons: InlineKeyboardButton[][] = [];

  for (const objectId of objectIds) {
    buttons.push([
      {
        text: `📌 Map #${objectId}`,
        callback_data: `map:${sessionId}:${customerId}:${objectId}`,
      },
    ]);
  }

  if (totalPages !== undefined && totalPages > 1) {
    const navButtons: InlineKeyboardButton[] = [];
    if (page > 1) {
      navButtons.push({ text: '⬅️ Previous', callback_data: `search_page:${sessionId}:${page - 1}` });
    }
    if (page < totalPages) {
      navButtons.push({ text: 'Next ➡️', callback_data: `search_page:${sessionId}:${page + 1}` });
    }
    if (navButtons.length > 0) {
      buttons.push(navButtons);
    }
  }

  buttons.push([
    {
      text: '🔍 Search other objects',
      callback_data: `map_search:${sessionId}:${customerId}`,
    },
  ]);

  buttons.push([
    { text: '❌ Cancel', callback_data: `map_cancel:${sessionId}:${customerId}` },
  ]);

  return { inline_keyboard: buttons };
}

export function createClientsPaginationKeyboard(token: string, page: number, totalPages: number): InlineKeyboardMarkup {
  const buttons: InlineKeyboardButton[][] = [];

  if (totalPages > 1) {
    const navButtons: InlineKeyboardButton[] = [];
    if (page > 1) {
      navButtons.push({ text: '◀ Previous', callback_data: `clients_page:${token}:${page - 1}` });
    }
    if (page < totalPages) {
      navButtons.push({ text: 'Next ▶', callback_data: `clients_page:${token}:${page + 1}` });
    }
    if (navButtons.length > 0) {
      buttons.push(navButtons);
    }
  }

  return { inline_keyboard: buttons };
}

export interface GroupAlertsCustomerInfo {
  customerId: number;
  clientId: string;
  name: string;
  canView: boolean;
  enabled: boolean;
  receiveAlerts: boolean;
}

export function createGroupAlertsKeyboard(
  token: string,
  customers: GroupAlertsCustomerInfo[],
  page: number,
  totalPages: number,
  pageSize: number
): InlineKeyboardMarkup {
  const buttons: InlineKeyboardButton[][] = [];

  for (const c of customers) {
    const target = c.receiveAlerts ? 'off' : 'on';
    const alertLabel = c.receiveAlerts ? '🔔 Alerts ON' : '🔕 Alerts OFF';
    const disabledOverlay = c.enabled ? '' : ' (disabled)';
    buttons.push([
      {
        text: `${c.clientId} - ${c.name}${disabledOverlay} | ${alertLabel}`,
        callback_data: `alerts_toggle:${token}:${c.customerId}:${target}`,
      },
    ]);
  }

  const bulkRow: InlineKeyboardButton[] = [
    { text: '🔔 Enable All', callback_data: `alerts_bulk:${token}:enable_all` },
    { text: '🔇 Disable All', callback_data: `alerts_bulk:${token}:disable_all` },
  ];
  buttons.push(bulkRow);

  if (totalPages > 1) {
    const navButtons: InlineKeyboardButton[] = [];
    if (page > 1) {
      navButtons.push({ text: '◀ Previous', callback_data: `alerts_page:${token}:${page - 1}` });
    }
    if (page < totalPages) {
      navButtons.push({ text: 'Next ▶', callback_data: `alerts_page:${token}:${page + 1}` });
    }
    if (navButtons.length > 0) {
      buttons.push(navButtons);
    }
  }

  buttons.push([{ text: '❌ Close', callback_data: `alerts_close:${token}` }]);

  return { inline_keyboard: buttons };
}

export interface GroupAlertsCallbackData {
  action: string;
  token: string;
  customerId?: number;
  toggleTarget?: 'on' | 'off';
  page?: number;
  bulkAction?: string;
  previewId?: string;
}

export function parseGroupAlertsCallback(data: string): GroupAlertsCallbackData | null {
  if (Buffer.byteLength(data, 'utf8') > 64) {
    return null;
  }

  const parts = data.split(':');
  if (parts.length < 2) return null;

  const action = parts[0];
  const token = parts[1];

  if (action === 'alerts_toggle' && parts.length === 4) {
    const customerId = parsePositiveInteger(parts[2]);
    if (customerId === null) return null;
    const target = parts[3];
    if (target !== 'on' && target !== 'off') return null;
    return { action, token, customerId: customerId!, toggleTarget: target };
  }

  if (action === 'alerts_page' && parts.length === 3) {
    const page = parsePositiveInteger(parts[2]);
    if (page === null) return null;
    return { action, token, page: page! };
  }

  if (action === 'alerts_bulk' && parts.length === 3) {
    const bulkAction = parts[2];
    if (bulkAction !== 'enable_all' && bulkAction !== 'disable_all') return null;
    return { action, token, bulkAction };
  }

  if (action === 'ga_confirm' && parts.length === 3) {
    return { action: 'ga_confirm', token, previewId: parts[2] };
  }

  if (action === 'ga_cancel' && parts.length === 3) {
    return { action: 'ga_cancel', token, previewId: parts[2] };
  }

  if (action === 'alerts_close' && parts.length === 2) {
    return { action: 'close', token };
  }

  return null;
}

export function createGroupAlertsBulkConfirmKeyboard(token: string, previewId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Confirm', callback_data: `ga_confirm:${token}:${previewId}` },
        { text: '❌ Cancel', callback_data: `ga_cancel:${token}:${previewId}` },
      ],
    ],
  };
}
