import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Telegraf, Telegram } from 'telegraf';
import { BotContext, createBot } from '@/integrations/telegram/bot';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { setPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { MappingService } from '@/modules/mapping/mapping.service';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { resetConfigForTesting } from '@/config/env';
import { customerRepository } from '@/modules/customers/customer.repository';
import type { InventorySnapshot } from '@/integrations/prtg/prtg.inventory.cache';
import {
  handleMapConfirm, handleMapCancel, handleMapSearch,
  handleMapSelect, handleMapVerify, handleSearchPagination,
} from '@/integrations/telegram/handlers/mapping-callbacks';

class FakeTelegramApi {
  public callbackQueryAnswers: string[] = [];
  public editedMessages: Array<{ text: string; options?: Record<string, unknown> }> = [];
  public sentMessages: string[] = [];

  async getMe(): Promise<{ id: number; first_name: string; is_bot: boolean; username: string }> {
    return { id: 123456789, first_name: 'TestBot', is_bot: true, username: 'test_bot' };
  }

  async answerCbQuery(_callbackQueryId: string, text?: string, _extra?: Record<string, unknown>): Promise<boolean> {
    this.callbackQueryAnswers.push(text || '');
    return true;
  }

  async editMessageText(_chatId: number | string, _messageId?: number, _inlineMessageId?: string, text?: string, extra?: Record<string, unknown>): Promise<unknown> {
    this.editedMessages.push({ text: text || '', options: extra });
    return { text, ...extra };
  }

  async sendMessage(chatId: number | string, text: string, _extra?: Record<string, unknown>): Promise<unknown> {
    this.sentMessages.push(text);
    return { chatId, text };
  }

  get editedMessage() {
    return this.editedMessages[this.editedMessages.length - 1]?.text ?? null;
  }

  get editedMessageOptions() {
    return this.editedMessages[this.editedMessages.length - 1]?.options ?? null;
  }

  get callbackQueryAnswer() {
    return this.callbackQueryAnswers[this.callbackQueryAnswers.length - 1] ?? null;
  }

  reset(): void {
    this.callbackQueryAnswers = [];
    this.editedMessages = [];
    this.sentMessages = [];
  }
}

let originalCallApi: typeof Telegram.prototype.callApi | undefined;

describe('Bot routing: callback dispatcher integration', () => {
  let bot: ReturnType<typeof createBot>;
  let fakeApi: FakeTelegramApi;
  let service: MappingService;

  const adminUserId = '12345678';
  const foreignAdminUserId = '87654321';
  const globalGroupId = '-1001234567890';
  const globalGroupIdNum = -1001234567890;

  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1,admin2');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();

    pendingMappingStore.cleanup();

    customerRepository.bulkCreate([
      { clientId: 'client1', name: 'Customer One', monitorType: 'prtg', pingHost: null, enabled: true },
      { clientId: 'client2', name: 'Customer Two', monitorType: 'prtg', pingHost: null, enabled: true },
    ]);

    fakeApi = new FakeTelegramApi();
    bot = createBot();
    // Register callback routes (mirrors src/app.ts)
    bot.action(/^map:[a-f0-9-]+:\d+:\d+$/i, handleMapSelect);
    bot.action(/map_confirm:.+/, handleMapConfirm);
    bot.action(/map_cancel:.+/, handleMapCancel);
    bot.action(/map_search:.+/, handleMapSearch);
    bot.action(/map_verify:.+/, handleMapVerify);
    bot.action(/search_page:.+/, handleSearchPagination);
    // Mock callApi on Telegram prototype (handleUpdate creates a new Telegram instance)
    originalCallApi = Telegram.prototype.callApi;
    Telegram.prototype.callApi = async (method: string, payload: any) => {
      if (method === 'getMe') {
        return { id: 123456789, first_name: 'TestBot', is_bot: true, username: 'test_bot' };
      }
      if (method === 'editMessageText') {
        fakeApi.editedMessages.push({ text: payload.text || '', options: payload });
        return { text: payload.text };
      }
      if (method === 'answerCallbackQuery') {
        // Telegraf passes callback_query_id in payload
        fakeApi.callbackQueryAnswers.push(payload.text || '');
        return true;
      }
      if (method === 'sendMessage') {
        fakeApi.sentMessages.push(payload.text);
        return { chat_id: payload.chat_id, text: payload.text };
      }
      return {};
    };

    service = new MappingService();

    vi.restoreAllMocks();

    vi.spyOn(accessService, 'isAdmin').mockImplementation((userId: string) => {
      return userId === adminUserId || userId === foreignAdminUserId;
    });
    vi.spyOn(accessService, 'canManageMappings').mockImplementation((ctx: { userId: string; chatId: string; chatType: string }) => {
      return ctx.userId === adminUserId || ctx.userId === foreignAdminUserId;
    });
    vi.spyOn(accessService, 'isGlobalGroup').mockReturnValue(true);
    vi.spyOn(accessService, 'isGroupChat').mockReturnValue(true);
    vi.spyOn(accessService, 'isPrivateChat').mockReturnValue(false);
  });

  afterEach(() => {
    if (originalCallApi) {
      Telegram.prototype.callApi = originalCallApi;
      originalCallApi = undefined;
    }
    vi.unstubAllEnvs();
  });

  function setupInventory(sensors: Array<{ objectId: number; deviceName: string; sensorName: string; sensorType: string }>) {
    const snap: InventorySnapshot = {
      sensors: sensors,
      devices: sensors.map(s => ({ objectId: s.objectId, deviceName: s.deviceName, monitorType: 'prtg' })),
      generation: 1,
      fetchedAt: new Date().toISOString(),
    } as InventorySnapshot;
    const cache = {
      getFresh: () => snap,
      getStale: () => snap,
      isStale: () => false,
      isExpired: () => false,
      generation: 1,
      refresh: async () => snap,
      forceRefresh: async () => snap,
    };
    setPrtgInventoryCache(cache as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);
    return snap;
  }

  async function dispatchCallback(bot: ReturnType<typeof createBot>, data: string, userId: string = adminUserId) {
    return bot.handleUpdate({
      update_id: Math.floor(Math.random() * 1000000),
      callback_query: {
        id: 'cb_' + Math.floor(Math.random() * 1000000),
        from: { id: Number(userId), is_bot: false, first_name: 'Test' },
        message: {
          message_id: 1,
          chat: { id: globalGroupIdNum, type: 'group' },
          date: Math.floor(Date.now() / 1000),
        },
        data: data,
      },
    } as any);
  }

  describe('Search → Next → Map → Confirm flow', () => {
    it('search Next→Map→Confirm reaches DB with correct target', async () => {
      const customer = customerService.getByClientId('client1');
      expect(customer).toBeDefined();

      const snap = setupInventory([
        { objectId: 1001, deviceName: 'Device-A', sensorName: 'Ping', sensorType: 'Ping' },
        { objectId: 1002, deviceName: 'Device-B', sensorName: 'Ping', sensorType: 'Ping' },
        { objectId: 1003, deviceName: 'Device-C', sensorName: 'Ping', sensorType: 'Ping' },
        { objectId: 1004, deviceName: 'Device-D', sensorName: 'Ping', sensorType: 'Ping' },
        { objectId: 1005, deviceName: 'Device-E', sensorName: 'Ping', sensorType: 'Ping' },
        { objectId: 1006, deviceName: 'Device-F', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      // Create search session with all candidates
      const searchSession = pendingMappingStore.createSearch({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: snap.generation,
        customerId: customer!.id,
        page: 1,
        candidates: [
          { objectId: 1001, deviceName: 'Device-A', sensorName: 'Ping', sensorType: 'Ping' },
          { objectId: 1002, deviceName: 'Device-B', sensorName: 'Ping', sensorType: 'Ping' },
          { objectId: 1003, deviceName: 'Device-C', sensorName: 'Ping', sensorType: 'Ping' },
          { objectId: 1004, deviceName: 'Device-D', sensorName: 'Ping', sensorType: 'Ping' },
          { objectId: 1005, deviceName: 'Device-E', sensorName: 'Ping', sensorType: 'Ping' },
          { objectId: 1006, deviceName: 'Device-F', sensorName: 'Ping', sensorType: 'Ping' },
        ],
      });

      // Generate page 1 keyboard (5 candidates, page 1 of 2 - has Next button)
      const keyboard1 = { inline_keyboard: [
        ...[1001, 1002, 1003, 1004, 1005].map(id => [{ text: `Map #${id}`, callback_data: `map:${searchSession.id}:${customer!.id}:${id}` }]),
        [{ text: '👀 Show more', callback_data: `search_page:${searchSession.id}:2` }],
        [{ text: 'Search Other Object', callback_data: `map_search:${searchSession.id}:${customer!.id}` }],
        [{ text: 'Cancel', callback_data: `map_cancel:${searchSession.id}:${customer!.id}` }],
      ] };

      // Find and dispatch Next (Show more) button
      const nextButton = keyboard1.inline_keyboard.find(row => row[0].text?.includes('Show more') || row[0].text?.includes('Next'));
      expect(nextButton).toBeDefined();
      const nextCallback = nextButton![0].callback_data;

      await dispatchCallback(bot, nextCallback);

      // Should have Map button for objectId 1006 (page 2)
      const mapButton = fakeApi.editedMessageOptions?.reply_markup?.inline_keyboard.find((row: Array<{text: string; callback_data: string}>) => row[0].text?.includes('Map #1006'));
      expect(mapButton).toBeDefined();

      // Dispatch Map select
      fakeApi.reset();
      const mapCallback = mapButton![0].callback_data;
      await dispatchCallback(bot, mapCallback);

      // Should show confirm preview with token
      const confirmButton = fakeApi.editedMessageOptions?.reply_markup?.inline_keyboard.find((row: Array<{text: string; callback_data: string}>) => row[0].callback_data?.startsWith('map_confirm:'));
      expect(confirmButton).toBeDefined();

      // Dispatch Confirm
      fakeApi.reset();
      const confirmCallback = confirmButton![0].callback_data;
      await dispatchCallback(bot, confirmCallback);

      // Verify mapping was created in DB
      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(1);
      expect(mappings[0].prtgObjectId).toBe(1006);
      expect(mappings[0].customerId).toBe(customer!.id);
      expect(mappings[0].mappingMethod).toBe('manual');
      expect(mappings[0].verified).toBe(true);
    });
  });

  describe('Search denial tests', () => {
    it('map:<valid-session>:0:4036 with admin lain rejected without editMessageText', async () => {
      const customer = customerService.getByClientId('client1');
      const snap = setupInventory([
        { objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      const searchSession = pendingMappingStore.createSearch({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: snap.generation,
        customerId: customer!.id,
        page: 1,
        candidates: [{ objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' }],
      });

      // Foreign admin tries to select with invalid customerId=0

      const callbackData = `map:${searchSession.id}:0:4036`;
      await dispatchCallback(bot, callbackData, foreignAdminUserId);

      // Should get answerCbQuery denial, no editMessageText
      expect(fakeApi.callbackQueryAnswer).toContain('Invalid');
      expect(fakeApi.editedMessage).toBeNull();

      // Session should still exist
      expect(pendingMappingStore.get(searchSession.id)).toBeDefined();
    });

    it('map:<valid-session>:<other-customer>:4036 with foreign admin rejected', async () => {
      const customer2 = customerService.getByClientId('client2');
      const snap = setupInventory([
        { objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      const searchSession = pendingMappingStore.createSearch({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: snap.generation,
        customerId: customer2!.id,
        page: 1,
        candidates: [{ objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' }],
      });


      const callbackData = `map:${searchSession.id}:${customer2!.id}:4036`;
      await dispatchCallback(bot, callbackData, foreignAdminUserId);

      expect(fakeApi.editedMessage).toBeNull();
      expect(pendingMappingStore.get(searchSession.id)).toBeDefined();
    });

    it('Confirm by foreign admin rejected without message change, token retained, DB unchanged', async () => {
      const customer = customerService.getByClientId('client1');
      const snap = setupInventory([
        { objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      // Owner creates a map session
      const { token } = service.prepareMapping(customer!.clientId, 4036, {
        userId: adminUserId,
        chatId: globalGroupId,
        chatType: 'private',
      }, snap);

      const confirmCallback = `map_confirm:${token}:${customer!.id}:4036`;

      // Foreign admin tries confirm

      await dispatchCallback(bot, confirmCallback, foreignAdminUserId);

      // Token must still be retained
      expect(pendingMappingStore.get(token)).toBeDefined();
      // No DB write
      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(0);
      // Message not changed (no editMessageText)
      expect(fakeApi.editedMessage).toBeNull();
    });

    it('Global non-admin cannot confirm mapping, no message change', async () => {
      const customer = customerService.getByClientId('client1');
      const snap = setupInventory([
        { objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      // Owner creates a map session
      const { token } = service.prepareMapping(customer!.clientId, 4036, {
        userId: adminUserId,
        chatId: globalGroupId,
        chatType: 'private',
      }, snap);

      const confirmCallback = `map_confirm:${token}:${customer!.id}:4036`;

      // Non-admin user
      const nonAdminId = '99999999';
      vi.spyOn(accessService, 'canManageMappings').mockImplementation((ctx: { userId: string }) => {
        return ctx.userId === adminUserId;
      });


      await dispatchCallback(bot, confirmCallback, nonAdminId);

      expect(fakeApi.editedMessage).toBeNull();
      expect(pendingMappingStore.get(token)).toBeDefined();
      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(0);
    });

    it('expired session cannot create confirmation, no writes', async () => {
      const customer = customerService.getByClientId('client1');
      const snap = setupInventory([
        { objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      const searchSession = pendingMappingStore.createSearch({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: snap.generation,
        customerId: customer!.id,
        page: 1,
        candidates: [{ objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' }],
      });

      // Simulate expiry by deleting session
      pendingMappingStore.delete(searchSession.id);


      const callbackData = `map:${searchSession.id}:${customer!.id}:4036`;
      await dispatchCallback(bot, callbackData);

      expect(fakeApi.callbackQueryAnswer).toContain('expired');
      expect(fakeApi.editedMessage).toBeNull();
      expect(pendingMappingStore.get(searchSession.id)).toBeUndefined();

      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(0);
    });
  });
});
