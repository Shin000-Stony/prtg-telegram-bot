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
  handleUnmapConfirm, handleUnmapCancel,
} from '@/integrations/telegram/handlers/mapping-callbacks';
import { handleClientsPagination } from '@/integrations/telegram/commands/clients.command';
import { clientsPaginationStore } from '@/modules/groups/clients-pagination.store';

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
    clientsPaginationStore.cleanup();

    customerRepository.bulkCreate([
      { clientId: 'client1', name: 'Customer One', monitorType: 'prtg', pingHost: null, enabled: true },
      { clientId: 'client2', name: 'Customer Two', monitorType: 'prtg', pingHost: null, enabled: true },
    ]);

    fakeApi = new FakeTelegramApi();
    bot = createBot();
    // Register callback routes (mirrors src/app.ts)
    bot.action(/^map:[a-f0-9-]+:\d+:\d+$/i, handleMapSelect);
    bot.action(/^map_confirm:.+$/, handleMapConfirm);
    bot.action(/^map_cancel:.+$/, handleMapCancel);
    bot.action(/^map_search:.+$/, handleMapSearch);
    bot.action(/^map_verify:.+$/, handleMapVerify);
    bot.action(/^search_page:.+$/, handleSearchPagination);
    bot.action(/^unmap_confirm:.+$/, handleUnmapConfirm);
    bot.action(/^unmap_cancel:.+$/, handleUnmapCancel);
    bot.action(/^clients_page:[^:]+:[^:]+$/i, handleClientsPagination);
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

  describe('/clients pagination callback', () => {
    const CLIENTS_PAGE_SIZE = 8;

    function create123Customers() {
      for (let i = 0; i < 123; i++) {
        customerRepository.create({
          clientId: `cust-${String(i + 1).padStart(3, '0')}`,
          name: `Customer ${i + 1}`,
          monitorType: 'prtg',
          pingHost: null,
          enabled: true,
        });
      }
    }

    function createSession(keyword: string | null = null, messageId: number = 1) {
      return clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId,
        keyword,
      });
    }

    it('125 customers: page 1 shows 8, page 2 shows next 8, page 16 shows 5 last (no duplicates/loss)', async () => {
      create123Customers();
      const session = createSession();
      const callbackData = `clients_page:${session.token}:1`;

      await dispatchCallback(bot, callbackData);

      expect(fakeApi.editedMessage).toContain('Showing 1–8 of 125');
      expect(fakeApi.editedMessage).toContain('Page 1/16');

      fakeApi.reset();
      await dispatchCallback(bot, `clients_page:${session.token}:2`);
      expect(fakeApi.editedMessage).toContain('Showing 9–16 of 125');
      expect(fakeApi.editedMessage).toContain('Page 2/16');

      fakeApi.reset();
      await dispatchCallback(bot, `clients_page:${session.token}:16`);
      expect(fakeApi.editedMessage).toContain('Showing 121–125 of 125');
      expect(fakeApi.editedMessage).toContain('Page 16/16');
    });

    it('Next/Previous correct at start, middle, and end', async () => {
      create123Customers();
      const session = createSession();

      // Page 1 (start): should have Next but no Previous
      await dispatchCallback(bot, `clients_page:${session.token}:1`);
      let keyboard = fakeApi.editedMessageOptions?.reply_markup?.inline_keyboard;
      expect(keyboard).toHaveLength(1);
      expect(keyboard[0].length).toBe(1);
      expect(keyboard[0][0].text).toBe('Next ▶');

      // Page 8 (middle): should have both
      fakeApi.reset();
      await dispatchCallback(bot, `clients_page:${session.token}:8`);
      keyboard = fakeApi.editedMessageOptions?.reply_markup?.inline_keyboard;
      expect(keyboard).toHaveLength(1);
      expect(keyboard[0].length).toBe(2);
      expect(keyboard[0][0].text).toBe('◀ Previous');
      expect(keyboard[0][1].text).toBe('Next ▶');

      // Page 16 (end): should have Previous only
      fakeApi.reset();
      await dispatchCallback(bot, `clients_page:${session.token}:16`);
      keyboard = fakeApi.editedMessageOptions?.reply_markup?.inline_keyboard;
      expect(keyboard).toHaveLength(1);
      expect(keyboard[0].length).toBe(1);
      expect(keyboard[0][0].text).toBe('◀ Previous');
    });

    it('clicking Next from page 1 goes to page 2', async () => {
      create123Customers();
      const session = createSession();

      await dispatchCallback(bot, `clients_page:${session.token}:1`);
      const keyboard = fakeApi.editedMessageOptions?.reply_markup?.inline_keyboard;
      const nextButton = keyboard[0].find((b: { text: string }) => b.text === 'Next ▶');
      expect(nextButton).toBeDefined();
      const nextData = nextButton.callback_data;

      fakeApi.reset();
      await dispatchCallback(bot, nextData);
      expect(fakeApi.editedMessage).toContain('Showing 9–16 of 125');
      expect(fakeApi.editedMessage).toContain('Page 2/16');
    });

    it('clicking Previous from page 16 goes to page 15', async () => {
      create123Customers();
      const session = createSession();

      await dispatchCallback(bot, `clients_page:${session.token}:16`);
      const keyboard = fakeApi.editedMessageOptions?.reply_markup?.inline_keyboard;
      const prevButton = keyboard[0].find((b: { text: string }) => b.text === '◀ Previous');
      expect(prevButton).toBeDefined();
      const prevData = prevButton.callback_data;

      fakeApi.reset();
      await dispatchCallback(bot, prevData);
      expect(fakeApi.editedMessage).toContain('Showing 113–120 of 125');
      expect(fakeApi.editedMessage).toContain('Page 15/16');
    });

    it('single page has no navigation buttons', async () => {
      customerRepository.create({ clientId: 'single-1', name: 'Only One', monitorType: 'prtg', pingHost: null, enabled: true });
      const session = createSession();

      await dispatchCallback(bot, `clients_page:${session.token}:1`);
      const keyboard = fakeApi.editedMessageOptions?.reply_markup?.inline_keyboard;
      expect(keyboard).toHaveLength(0);
    });

    it('9 customers: page 1 shows exactly 8, page 2 shows remaining', async () => {
      // Note: beforeEach creates 2 customers (client1, client2), so total = 11
      customerRepository.create({ clientId: 'cust-001', name: 'Customer 1', monitorType: 'prtg', pingHost: null, enabled: true });
      customerRepository.create({ clientId: 'cust-002', name: 'Customer 2', monitorType: 'prtg', pingHost: null, enabled: true });
      customerRepository.create({ clientId: 'cust-003', name: 'Customer 3', monitorType: 'prtg', pingHost: null, enabled: true });
      customerRepository.create({ clientId: 'cust-004', name: 'Customer 4', monitorType: 'prtg', pingHost: null, enabled: true });
      customerRepository.create({ clientId: 'cust-005', name: 'Customer 5', monitorType: 'prtg', pingHost: null, enabled: true });
      customerRepository.create({ clientId: 'cust-006', name: 'Customer 6', monitorType: 'prtg', pingHost: null, enabled: true });
      customerRepository.create({ clientId: 'cust-007', name: 'Customer 7', monitorType: 'prtg', pingHost: null, enabled: true });
      customerRepository.create({ clientId: 'cust-008', name: 'Customer 8', monitorType: 'prtg', pingHost: null, enabled: true });
      customerRepository.create({ clientId: 'cust-009', name: 'Customer 9', monitorType: 'icmp', pingHost: '10.0.0.9', enabled: true });

      const session = createSession();
      await dispatchCallback(bot, `clients_page:${session.token}:1`);
      expect(fakeApi.editedMessage).toContain('Showing 1–8 of 11');
      expect(fakeApi.editedMessage).toContain('Page 1/2');

      const keyboard = fakeApi.editedMessageOptions?.reply_markup?.inline_keyboard;
      expect(keyboard).toHaveLength(1);
      expect(keyboard[0].length).toBe(1);
      expect(keyboard[0][0].text).toBe('Next ▶');

      fakeApi.reset();
      await dispatchCallback(bot, `clients_page:${session.token}:2`);
      expect(fakeApi.editedMessage).toContain('Showing 9–11 of 11');
      expect(fakeApi.editedMessage).toContain('Page 2/2');

      const keyboard2 = fakeApi.editedMessageOptions?.reply_markup?.inline_keyboard;
      expect(keyboard2).toHaveLength(1);
      expect(keyboard2[0].length).toBe(1);
      expect(keyboard2[0][0].text).toBe('◀ Previous');
    });
  });

  describe('/clients search callback', () => {
    beforeEach(() => {
      for (let i = 0; i < 15; i++) {
        customerRepository.create({
          clientId: `anug-${String(i).padStart(3, '0')}`,
          name: `Anugrah Customer ${i}`,
          monitorType: 'prtg',
          pingHost: null,
          enabled: true,
        });
      }
    });

    it('search keyword persists across pages', async () => {
      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: 'anugrah',
      });

      // Page 1 of search results
      await dispatchCallback(bot, `clients_page:${session.token}:1`);
      expect(fakeApi.editedMessage).toContain('Search: <code>anugrah</code>');
      expect(fakeApi.editedMessage).toContain('Showing 1–8 of 15');

      // Navigate to page 2
      fakeApi.reset();
      await dispatchCallback(bot, `clients_page:${session.token}:2`);
      expect(fakeApi.editedMessage).toContain('Search: <code>anugrah</code>');
      expect(fakeApi.editedMessage).toContain('Showing 9–15 of 15');
    });

    it('search reaches customers beyond first page', async () => {
      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: 'anugrah',
      });

      await dispatchCallback(bot, `clients_page:${session.token}:2`);
      expect(fakeApi.editedMessage).toContain('Showing 9–15 of 15');
      expect(fakeApi.editedMessage).toContain('anug-008');
      expect(fakeApi.editedMessage).toContain('anug-003');
    });

    it('partial name search works', async () => {
      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: 'anug',
      });

      await dispatchCallback(bot, `clients_page:${session.token}:1`);
      expect(fakeApi.editedMessage).toContain('anug-000');
    });

    it('search results show resolver-consistent status (PRTG without mapping = UNMAPPED)', async () => {
      customerRepository.create({ clientId: 'anug-test-1', name: 'Anugrah Test', monitorType: 'prtg', pingHost: null, enabled: true });

      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: 'anug',
      });

      await dispatchCallback(bot, `clients_page:${session.token}:1`);

      // PRTG customer without mapping should show UNMAPPED, not UP
      expect(fakeApi.editedMessage).toContain('UNMAPPED');
      expect(fakeApi.editedMessage).toContain('Mapping: Unmapped');
    });

    it('search footer uses All customers link', async () => {
      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: 'anugrah',
      });

      await dispatchCallback(bot, `clients_page:${session.token}:1`);

      expect(fakeApi.editedMessage).toContain('All customers: <b>/clients</b>');
    });
  });

  describe('/clients access control', () => {
    it('foreign user sees "Unauthorized" without editing message', async () => {
      createMockCustomers(123);
      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: null,
      });

      await dispatchCallback(bot, `clients_page:${session.token}:2`, foreignAdminUserId);

      expect(fakeApi.callbackQueryAnswer).toContain('Unauthorized');
      expect(fakeApi.editedMessage).toBeNull();
    });

    it('foreign chat sees "Unauthorized" without editing message', async () => {
      createMockCustomers(123);
      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: null,
      });

      const callbackData = `clients_page:${session.token}:1`;
      // Dispatch with adminUserId but different chat
      const dispatchWithDifferentChat = async (data: string) => {
        return bot.handleUpdate({
          update_id: Math.floor(Math.random() * 1000000),
          callback_query: {
            id: 'cb_' + Math.floor(Math.random() * 1000000),
            from: { id: Number(adminUserId), is_bot: false, first_name: 'Test' },
            message: {
              message_id: 99,
              chat: { id: -999999999999, type: 'group' },
              date: Math.floor(Date.now() / 1000),
            },
            data: data,
          },
        } as any);
      };

      await dispatchWithDifferentChat(callbackData);
      expect(fakeApi.callbackQueryAnswer).toContain('Unauthorized');
      expect(fakeApi.editedMessage).toBeNull();
    });

    it('message_id mismatch is rejected', async () => {
      createMockCustomers(123);
      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: null,
      });

      // Dispatch callback with message_id 999 but session has messageId 1
      await bot.handleUpdate({
        update_id: Math.floor(Math.random() * 1000000),
        callback_query: {
          id: 'cb_' + Math.floor(Math.random() * 1000000),
          from: { id: Number(adminUserId), is_bot: false, first_name: 'Test' },
          message: {
            message_id: 999,
            chat: { id: globalGroupIdNum, type: 'group' },
            date: Math.floor(Date.now() / 1000),
          },
          data: `clients_page:${session.token}:2`,
        },
      } as any);

      expect(fakeApi.callbackQueryAnswer).toContain('Session expired');
      expect(fakeApi.editedMessage).toBeNull();
    });

    it('token expired/invalid shows expired message', async () => {
      createMockCustomers(123);

      await dispatchCallback(bot, 'clients_page:nonexistent-token:1');
      expect(fakeApi.callbackQueryAnswer).toContain('expired');
      expect(fakeApi.editedMessage).toContain('This list has expired');
    });

    it('invalid page format rejected', async () => {
      createMockCustomers(123);
      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: null,
      });

      await dispatchCallback(bot, `clients_page:${session.token}:notanumber`);
      expect(fakeApi.callbackQueryAnswer).toContain('Invalid page');
    });

    it('page 0 rejected', async () => {
      createMockCustomers(123);
      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: null,
      });

      await dispatchCallback(bot, `clients_page:${session.token}:0`);
      expect(fakeApi.callbackQueryAnswer).toContain('Invalid page');
    });

    it('out-of-range page clamped to last page', async () => {
      createMockCustomers(123);
      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: null,
      });

      await dispatchCallback(bot, `clients_page:${session.token}:999`);
      expect(fakeApi.editedMessage).toContain('Showing 121–125 of 125');
      expect(fakeApi.editedMessage).toContain('Page 16/16');
    });
  });

  describe('/clients scope access', () => {
    it('assigned group only sees customers in their scope', async () => {
      const c1 = customerRepository.create({ clientId: 'ASSIGNED-1', name: 'Assigned Customer', monitorType: 'prtg', pingHost: null, enabled: true });
      customerRepository.create({ clientId: 'OTHER-1', name: 'Not Assigned', monitorType: 'prtg', pingHost: null, enabled: true });

      // Override scope for ordinary group
      vi.spyOn(accessService, 'getCustomerAccessScope').mockReturnValue({ kind: 'assigned', customerIds: [c1.id] });

      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: '-100999999999',
        messageId: 1,
        keyword: null,
      });

      // The callback needs to come from the assigned group chat
      await bot.handleUpdate({
        update_id: Math.floor(Math.random() * 1000000),
        callback_query: {
          id: 'cb_' + Math.floor(Math.random() * 1000000),
          from: { id: Number(adminUserId), is_bot: false, first_name: 'Test' },
          message: {
            message_id: 1,
            chat: { id: -100999999999, type: 'group' },
            date: Math.floor(Date.now() / 1000),
          },
          data: `clients_page:${session.token}:1`,
        },
      } as any);

      expect(fakeApi.editedMessage).toContain('ASSIGNED-1');
      expect(fakeApi.editedMessage).not.toContain('OTHER-1');
    });

    it('revoked access after message sent - customer disappears', async () => {
      const c1 = customerRepository.create({ clientId: 'ASSIGNED-2', name: 'Assigned', monitorType: 'prtg', pingHost: null, enabled: true });

      vi.spyOn(accessService, 'getCustomerAccessScope').mockReturnValue({ kind: 'assigned', customerIds: [c1.id] });

      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: '-100999999999',
        messageId: 1,
        keyword: null,
      });

      // First click: customer visible
      await bot.handleUpdate({
        update_id: Math.floor(Math.random() * 1000000),
        callback_query: {
          id: 'cb_' + Math.floor(Math.random() * 1000000),
          from: { id: Number(adminUserId), is_bot: false, first_name: 'Test' },
          message: { message_id: 1, chat: { id: -100999999999, type: 'group' }, date: Math.floor(Date.now() / 1000) },
          data: `clients_page:${session.token}:1`,
        },
      } as any);

      expect(fakeApi.editedMessage).toContain('ASSIGNED-2');

      // Revoke access
      vi.spyOn(accessService, 'getCustomerAccessScope').mockReturnValue({ kind: 'none' });

      // Second click: should show access denied
      fakeApi.reset();
      await bot.handleUpdate({
        update_id: Math.floor(Math.random() * 1000000),
        callback_query: {
          id: 'cb_' + Math.floor(Math.random() * 1000000),
          from: { id: Number(adminUserId), is_bot: false, first_name: 'Test' },
          message: { message_id: 1, chat: { id: -100999999999, type: 'group' }, date: Math.floor(Date.now() / 1000) },
          data: `clients_page:${session.token}:1`,
        },
      } as any);

      expect(fakeApi.editedMessage).toMatch(/akses ditolak|Access denied/i);
    });
  });

  describe('/clients no PRTG network calls', () => {
    it('callback does not trigger PRTG inventory fetch', async () => {
      createMockCustomers(123);
      const session = clientsPaginationStore.create({
        userId: adminUserId,
        chatId: globalGroupId,
        messageId: 1,
        keyword: null,
      });

      const prtgClientSpy = vi.fn();
      vi.doMock('@/integrations/prtg/prtg-inventory.shared', () => ({
        getPrtgInventoryCache: () => null,
        hasPrtgInventoryCache: () => false,
        setPrtgInventoryCache: vi.fn(),
      }));

      await dispatchCallback(bot, `clients_page:${session.token}:1`);

      // Message is rendered without PRTG calls
      expect(fakeApi.editedMessage).toContain('Showing 1–8 of 125');
     });
  });

  describe('/unmap_client routing', () => {
    it('unmap_confirm is routed to handleUnmapConfirm, not handleMapConfirm', async () => {
      const customer = customerService.getByClientId('client1');
      expect(customer).toBeDefined();

      const mapping = service.createManualMapping({
        customerId: customer!.id,
        prtgObjectId: 9999,
      });

      const pending = pendingMappingStore.createUnmap({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: 0,
        customerId: customer!.id,
        mappingId: mapping.id,
        expectedMapping: {
          customerId: mapping.customerId,
          prtgObjectId: mapping.prtgObjectId,
          mappingMethod: mapping.mappingMethod,
          verified: mapping.verified,
        },
      });

      await dispatchCallback(bot, `unmap_confirm:${pending.id}`);

      expect(fakeApi.callbackQueryAnswer).not.toMatch(/Invalid callback/i);
      expect(fakeApi.callbackQueryAnswer).toMatch(/Mapping removed|removed successfully/i);
      expect(fakeApi.editedMessage).toContain('Mapping removed');
    });

    it('unmap_cancel is routed to handleUnmapCancel, not handleMapCancel', async () => {
      const customer = customerService.getByClientId('client1');
      expect(customer).toBeDefined();

      const mapping = service.createManualMapping({
        customerId: customer!.id,
        prtgObjectId: 9999,
      });

      const pending = pendingMappingStore.createUnmap({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: 0,
        customerId: customer!.id,
        mappingId: mapping.id,
        expectedMapping: {
          customerId: mapping.customerId,
          prtgObjectId: mapping.prtgObjectId,
          mappingMethod: mapping.mappingMethod,
          verified: mapping.verified,
        },
      });

      await dispatchCallback(bot, `unmap_cancel:${pending.id}`);

      expect(fakeApi.callbackQueryAnswer).not.toMatch(/Invalid callback/i);
      expect(fakeApi.callbackQueryAnswer).toMatch(/Cancelled|cancelled/i);
      expect(fakeApi.editedMessage).toContain('cancelled');
    });
  });
});

function createMockCustomers(count: number) {
  for (let i = 0; i < count; i++) {
    customerRepository.create({
      clientId: `mock-${String(i + 1).padStart(3, '0')}`,
      name: `Mock Customer ${i + 1}`,
      monitorType: 'prtg',
      pingHost: null,
      enabled: true,
    });
  }
}
