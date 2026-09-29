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
