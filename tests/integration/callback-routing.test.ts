import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { MappingService } from '@/modules/mapping/mapping.service';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { runMigrations, resetMigrationsForTesting } from '@/infrastructure/database/migration-runner';
import { resetConfigForTesting } from '@/config/env';
import { customerRepository } from '@/modules/customers/customer.repository';
import type { InventorySnapshot } from '@/integrations/prtg/prtg.inventory.cache';
import { createSearchKeyboard, createMappingKeyboard, createVerifyMappingKeyboard } from '@/integrations/telegram/ui/cards';
import {
  handleMapSelect, handleMapConfirm, handleMapCancel, handleMapVerify,
  handleMapSearch, handleSearchPagination, handleAutoMapApply, handleAutoMapCancel,
  handleUnmapConfirm, handleUnmapCancel
} from '@/integrations/telegram/handlers/mapping-callbacks';
import { setPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import type { Context } from 'telegraf';

interface FakeApiState {
  answers: string[];
  edits: Array<{ text: string; options?: Record<string, unknown> }>;
  sent: string[];
}

function createFakeContext(callbackData: string, opts: { userId?: string; chatId?: string }, state: FakeApiState): { ctx: Context } {
  const chatIdNum = Number(opts.chatId || '-1001234567890');
  const ctx = {
    callbackQuery: { data: callbackData, message: { message_id: 1, chat: { id: chatIdNum } } },
    from: { id: Number(opts.userId || '12345678'), is_bot: false, first_name: 'Test' },
    chat: { id: chatIdNum, type: 'group' },
    chatId: opts.chatId || '-1001234567890',
    chatType: 'group',
    userId: opts.userId || '12345678',

    answerCbQuery: async (text?: string) => { state.answers.push(text || ''); return true; },
    editMessageText: async (text: string, options?: Record<string, unknown>) => {
      state.edits.push({ text, options });
      return { text, options };
    },
    reply: async (text: string) => { state.sent.push(text); return true; },
  } as unknown as Context;

  return { ctx };
}

// Simulate bot action routing by matching the same regex from app.ts
function routeCallback(data: string, ctx: Context, state: FakeApiState): Promise<void> {
  const handlers: Array<{ regex: RegExp; fn: (ctx: Context) => Promise<void> }> = [
    { regex: /^map:\d+:\d+$/, fn: handleMapSelect },
    { regex: /^map:[a-f0-9-]+:\d+:\d+$/i, fn: handleMapSelect },
    { regex: /^map_confirm:.+/, fn: handleMapConfirm },
    { regex: /^map_cancel:.+/, fn: handleMapCancel },
    { regex: /^map_search:.+/, fn: handleMapSearch },
    { regex: /^map_verify:.+/, fn: handleMapVerify },
    { regex: /^search_page:.+/, fn: handleSearchPagination },
    { regex: /^auto_apply:.+/, fn: handleAutoMapApply },
    { regex: /^auto_cancel:.+/, fn: handleAutoMapCancel },
    { regex: /^unmap_confirm:.+/, fn: handleUnmapConfirm },
    { regex: /^unmap_cancel:.+/, fn: handleUnmapCancel },
  ];

  for (const h of handlers) {
    if (h.regex.test(data)) {
      return h.fn(ctx);
    }
  }
  return Promise.resolve();
}

describe('Callback routing: full flow integration tests', () => {
  let service: MappingService;
  const adminUserId = '12345678';
  const foreignUserId = '87654321';
  const globalGroupId = '-1001234567890';

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

    service = new MappingService();

    vi.restoreAllMocks();
    vi.spyOn(accessService, 'isAdmin').mockImplementation((userId: string) => {
      return userId === adminUserId || userId === foreignUserId;
    });
    vi.spyOn(accessService, 'canManageMappings').mockImplementation((ctx: { userId: string; chatId: string; chatType: string }) => {
      return ctx.userId === adminUserId || ctx.userId === foreignUserId;
    });
    vi.spyOn(accessService, 'isGlobalGroup').mockReturnValue(true);
    vi.spyOn(accessService, 'isGroupChat').mockReturnValue(true);
    vi.spyOn(accessService, 'isPrivateChat').mockReturnValue(false);

    const snap: InventorySnapshot = {
      sensors: [],
      devices: [],
      generation: 1,
      fetchedAt: new Date().toISOString(),
    } as InventorySnapshot;
    const cache = {
      getFresh: () => snap,
      getStale: () => snap,
      isStale: () => false,
      isExpired: () => false,
    };
    setPrtgInventoryCache(cache as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function setupInventory(sensors: Array<{ objectId: number; deviceName: string; sensorName: string; sensorType: string }>): InventorySnapshot {
    const snap: InventorySnapshot = {
      sensors: sensors,
      devices: sensors.map(s => ({ objectId: s.objectId, deviceName: s.deviceName, monitorType: 'prtg' })),
      generation: 2,
      fetchedAt: new Date().toISOString(),
    } as InventorySnapshot;
    const cache = {
      getFresh: () => snap,
      getStale: () => snap,
      isStale: () => false,
      isExpired: () => false,
    };
    setPrtgInventoryCache(cache as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);
    return snap;
  }

  describe('Search → Next → Map → Confirm', () => {
    it('owner search Next→Map→Confirm reaches DB with correct target', async () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');

      setupInventory([
        { objectId: 1001, deviceName: 'Device-A', sensorName: 'Ping', sensorType: 'Ping' },
        { objectId: 1002, deviceName: 'Device-B', sensorName: 'Ping', sensorType: 'Ping' },
        { objectId: 1003, deviceName: 'Device-C', sensorName: 'Ping', sensorType: 'Ping' },
        { objectId: 1004, deviceName: 'Device-D', sensorName: 'Ping', sensorType: 'Ping' },
        { objectId: 1005, deviceName: 'Device-E', sensorName: 'Ping', sensorType: 'Ping' },
        { objectId: 1006, deviceName: 'Device-F', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      // Create search session with all 6 candidates
      const searchSession = pendingMappingStore.createSearch({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: 2,
        customerId: customer.id,
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

      // Generate keyboard for page 2 (object 1006, Next from page 1)
      const keyboard = createSearchKeyboard(searchSession.id, customer.id, [1006], 2, 2);
      const mapButton = keyboard.inline_keyboard.find(row => row[0].callback_data?.startsWith('map:'))!;
      const mapCallback = mapButton[0].callback_data;

      // Dispatch Map select through router (real app.ts regex pattern)
      const state: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx } = createFakeContext(mapCallback, { userId: adminUserId, chatId: globalGroupId }, state);
      await routeCallback(mapCallback, ctx, state);

      // Should show confirm preview
      const confirmEdit = state.edits[state.edits.length - 1];
      expect(confirmEdit).toBeDefined();
      const confirmButton = confirmEdit.options?.reply_markup?.inline_keyboard.find((row: Array<{text: string; callback_data: string}>) => row[0].callback_data?.startsWith('map_confirm:'));
      expect(confirmButton).toBeDefined();

      // Extract token from callback_data and dispatch Confirm
      const confirmCallback = confirmButton[0].callback_data;
      const confirmState: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx: confirmCtx } = createFakeContext(confirmCallback, { userId: adminUserId, chatId: globalGroupId }, confirmState);
      await routeCallback(confirmCallback, confirmCtx, confirmState);

      // Verify mapping was created in DB with correct target
      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(1);
      expect(mappings[0].prtgObjectId).toBe(1006);
      expect(mappings[0].customerId).toBe(customer.id);
      expect(mappings[0].mappingMethod).toBe('manual');
      expect(mappings[0].verified).toBe(true);
    });
  });

  describe('Denial: invalid identity in map callback', () => {
    it('map:<valid-session>:0:4036 with foreign admin: rejected via answerCbQuery, no editMessageText', async () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');

      const snap = setupInventory([
        { objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      const searchSession = pendingMappingStore.createSearch({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: snap.generation,
        customerId: customer.id,
        page: 1,
        candidates: [{ objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' }],
      });

      const callbackData = `map:${searchSession.id}:0:4036`;
      const state: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx } = createFakeContext(callbackData, { userId: foreignUserId, chatId: globalGroupId }, state);
      await routeCallback(callbackData, ctx, state);

      // Should get answerCbQuery denial
      expect(state.answers.length).toBeGreaterThan(0);
      // No editMessageText
      expect(state.edits).toHaveLength(0);
      // Session still valid
      expect(pendingMappingStore.get(searchSession.id)).toBeDefined();
    });
  });

  describe('Denial: foreign admin or non-admin confirm', () => {
    it('confirm by foreign admin: no message edit, token retained, DB unchanged', async () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');

      const snap = setupInventory([
        { objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      // Owner creates a map session (preview)
      const { token } = service.prepareMapping(customer.clientId, 4036, {
        userId: adminUserId,
        chatId: globalGroupId,
        chatType: 'private',
      }, snap);

      const confirmCallback = `map_confirm:${token}:${customer.id}:4036`;

      const state: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx } = createFakeContext(confirmCallback, { userId: foreignUserId, chatId: globalGroupId }, state);
      await routeCallback(confirmCallback, ctx, state);

      // Token must still be retained
      expect(pendingMappingStore.get(token)).toBeDefined();
      // No DB write
      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(0);
      // No message edit (denial via answerCbQuery only)
      expect(state.edits).toHaveLength(0);
    });

    it('confirm by non-admin: no message edit, token retained, DB unchanged', async () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');

      const snap = setupInventory([
        { objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      // Make non-admin not allowed
      vi.spyOn(accessService, 'canManageMappings').mockImplementation((ctx: { userId: string }) => {
        return ctx.userId === adminUserId;
      });

      // Owner creates a map session
      const { token } = service.prepareMapping(customer.clientId, 4036, {
        userId: adminUserId,
        chatId: globalGroupId,
        chatType: 'private',
      }, snap);

      const confirmCallback = `map_confirm:${token}:${customer.id}:4036`;

      // Non-admin tries
      const state: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx } = createFakeContext(confirmCallback, { userId: '99999999', chatId: globalGroupId }, state);
      await routeCallback(confirmCallback, ctx, state);

      // Token retained
      expect(pendingMappingStore.get(token)).toBeDefined();
      // No DB writes
      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(0);
      // No message edit
      expect(state.edits).toHaveLength(0);
    });

    it('owner confirm succeeds after foreign admin denial', async () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');

      const snap = setupInventory([
        { objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      // Owner creates a map session
      const { token } = service.prepareMapping(customer.clientId, 4036, {
        userId: adminUserId,
        chatId: globalGroupId,
        chatType: 'private',
      }, snap);

      const confirmCallback = `map_confirm:${token}:${customer.id}:4036`;

      // Foreign admin tries first
      const foreignState: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx: foreignCtx } = createFakeContext(confirmCallback, { userId: foreignUserId, chatId: globalGroupId }, foreignState);
      await routeCallback(confirmCallback, foreignCtx, foreignState);

      // Token should still be there
      expect(pendingMappingStore.get(token)).toBeDefined();

      // Owner confirms successfully
      const ownerState: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx: ownerCtx } = createFakeContext(confirmCallback, { userId: adminUserId, chatId: globalGroupId }, ownerState);
      await routeCallback(confirmCallback, ownerCtx, ownerState);

      // Mapping should be created
      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(1);
      expect(mappings[0].prtgObjectId).toBe(4036);
    });
  });

  describe('Session expiry/cancel denial', () => {
    it('expired/deleted search session: Map denied via answerCbQuery, no edits, no writes', async () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');

      const snap = setupInventory([
        { objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      const searchSession = pendingMappingStore.createSearch({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: snap.generation,
        customerId: customer.id,
        page: 1,
        candidates: [{ objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' }],
      });

      // Delete session to simulate expiry
      pendingMappingStore.delete(searchSession.id);

      const callbackData = `map:${searchSession.id}:${customer.id}:4036`;
      const state: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx } = createFakeContext(callbackData, { userId: adminUserId, chatId: globalGroupId }, state);
      await routeCallback(callbackData, ctx, state);

      // Denied via answerCbQuery
      expect(state.answers.length).toBeGreaterThan(0);
      // No message edit
      expect(state.edits).toHaveLength(0);
      // No DB writes
      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(0);
    });

    it('delete search session via Cancel: session invalidated', async () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');

      const snap = setupInventory([
        { objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      const searchSession = pendingMappingStore.createSearch({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: snap.generation,
        customerId: customer.id,
        page: 1,
        candidates: [{ objectId: 4036, deviceName: 'Device-X', sensorName: 'Ping', sensorType: 'Ping' }],
      });

      const cancelCallback = `map_cancel:${searchSession.id}:${customer.id}`;
      const state: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx } = createFakeContext(cancelCallback, { userId: adminUserId, chatId: globalGroupId }, state);
      await routeCallback(cancelCallback, ctx, state);

      // Session should be deleted
      expect(pendingMappingStore.get(searchSession.id)).toBeUndefined();

      // Old buttons should not work
      const retryState: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx: retryCtx } = createFakeContext(`map:${searchSession.id}:${customer.id}:4036`, { userId: adminUserId, chatId: globalGroupId }, retryState);
      await routeCallback(`map:${searchSession.id}:${customer.id}:4036`, retryCtx, retryState);

      expect(retryState.answers.some(a => a.includes('expired') || a.includes('invalid'))).toBe(true);
      expect(retryState.edits).toHaveLength(0);
    });
  });

  describe('map_client candidates flow', () => {
    it('map_client Map→Confirm reaches DB with correct target via keyboard dispatch', async () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');

      const snap = setupInventory([
        { objectId: 5001, deviceName: 'Device-MapCli', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      // Simulate the session created by map_client command
      const searchSession = pendingMappingStore.createSearch({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: snap.generation,
        customerId: customer.id,
        page: 1,
        candidates: [{ objectId: 5001, deviceName: 'Device-MapCli', sensorName: 'Ping', sensorType: 'Ping' }],
      });

      // Generate keyboard (simulating createMappingKeyboard from map-client command)
      const keyboard = createMappingKeyboard(searchSession.id, customer.id, [5001]);
      const mapButton = keyboard.inline_keyboard.find(row => row[0].callback_data?.startsWith('map:'))!;
      const mapCallback = mapButton[0].callback_data;

      const state: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx } = createFakeContext(mapCallback, { userId: adminUserId, chatId: globalGroupId }, state);
      await routeCallback(mapCallback, ctx, state);

      // Should show confirm preview
      const confirmEdit = state.edits[state.edits.length - 1];
      expect(confirmEdit).toBeDefined();
      const confirmButton = confirmEdit.options?.reply_markup?.inline_keyboard.find((row: Array<{text: string; callback_data: string}>) => row[0].callback_data?.startsWith('map_confirm:'));
      expect(confirmButton).toBeDefined();

      // Dispatch Confirm
      const confirmCallback = confirmButton[0].callback_data;
      const confirmState: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx: confirmCtx } = createFakeContext(confirmCallback, { userId: adminUserId, chatId: globalGroupId }, confirmState);
      await routeCallback(confirmCallback, confirmCtx, confirmState);

      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(1);
      expect(mappings[0].prtgObjectId).toBe(5001);
    });
  });

  describe('client Verify AUTO flow', () => {
    it('client Verify AUTO→Confirm verifies existing mapping via keyboard dispatch', async () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');

      const snap = setupInventory([
        { objectId: 6001, deviceName: 'Device-Verify', sensorName: 'Ping', sensorType: 'Ping' },
      ]);

      // Create an AUTO mapping first
      const autoMapping = mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 6001,
        prtgDeviceName: 'Device-Verify',
        prtgSensorName: 'Ping',
        mappingMethod: 'auto',
        confidence: 0.9,
        verified: false,
        mappedByTelegramId: adminUserId,
      });

      // Create search session (simulating what /client command does)
      const searchSession = pendingMappingStore.createSearch({
        chatId: globalGroupId,
        userId: adminUserId,
        inventoryGeneration: snap.generation,
        customerId: customer.id,
        page: 1,
        candidates: [{ objectId: 6001, deviceName: 'Device-Verify', sensorName: 'Ping', sensorType: 'Ping' }],
      });

      // Generate keyboard (simulating createVerifyMappingKeyboard from client command)
      const keyboard = createVerifyMappingKeyboard(searchSession.id, customer.id, 6001);
      const verifyCallback = keyboard.inline_keyboard[0][0].callback_data;

      // Dispatch Verify through router
      const state: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx } = createFakeContext(verifyCallback, { userId: adminUserId, chatId: globalGroupId }, state);
      await routeCallback(verifyCallback, ctx, state);

      // Should show confirm preview with existing mapping
      const confirmEdit = state.edits[state.edits.length - 1];
      expect(confirmEdit).toBeDefined();
      const confirmButton = confirmEdit.options?.reply_markup?.inline_keyboard.find((row: Array<{text: string; callback_data: string}>) => row[0].callback_data?.startsWith('map_confirm:'));
      expect(confirmButton).toBeDefined();
      expect(confirmEdit.text).toContain('Existing AUTO mapping is verified');

      // Dispatch Confirm
      const confirmCallback = confirmButton[0].callback_data;
      const confirmState: FakeApiState = { answers: [], edits: [], sent: [] };
      const { ctx: confirmCtx } = createFakeContext(confirmCallback, { userId: adminUserId, chatId: globalGroupId }, confirmState);
      await routeCallback(confirmCallback, confirmCtx, confirmState);

      // Mapping should be verified
      const updated = mappingRepository.findById(autoMapping.id);
      expect(updated).toBeDefined();
      expect(updated!.verified).toBe(true);
    });
  });
});
