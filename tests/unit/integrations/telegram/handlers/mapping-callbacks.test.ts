import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleMapCancel, handleAutoMapCancel, handleUnmapCancel, handleMapSearch, handleSearchPagination } from '@/integrations/telegram/handlers/mapping-callbacks';
import { pendingMappingStore, PendingMap, PendingAutoMap, PendingUnmap, PendingSearch } from '@/modules/mapping/pending-mapping.store';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';

interface FakeBotContext {
  callbackQuery?: { data?: string; message?: { message_id?: number; chat?: { id?: number } } };
  from?: { id: number; is_bot: boolean; first_name: string };
  chatId?: number;
  chatType?: string;
  message?: { text?: string };
  answers: string[];
  edits: Array<{ text: string; options?: Record<string, unknown> }>;
}

function createFakeContext(data: string, opts: { userId?: number; chatId?: number; chatType?: string; fromId?: number } = {}): FakeBotContext {
  const ctx = {
    callbackQuery: { data },
    from: { id: opts.fromId ?? opts.userId ?? 12345678, is_bot: false, first_name: 'Test' },
    chatId: opts.chatId !== undefined ? String(opts.chatId) : '-1001234567890',
    chatType: opts.chatType ?? 'group',
    answers: [],
    edits: [],
  };
  return ctx;
}

function makeFakeBotContext(fake: FakeBotContext) {
  const ctx = {
    ...fake,
    answerCbQuery: async (text?: string) => { fake.answers.push(text || ''); return true; },
    editMessageText: async (text: string, options?: Record<string, unknown>) => {
      fake.edits.push({ text, options });
      return { text, options };
    },
    reply: async (_text: string) => true,
  };
  return ctx as unknown as Parameters<typeof handleMapCancel>[0];
}

describe('Callback handler security and validation', () => {
  beforeEach(() => {
    pendingMappingStore.cleanup();
    vi.restoreAllMocks();
  });

  describe('handleMapCancel', () => {
    it('rejects tokenless cancel (map_cancel:customerId format)', async () => {
      const fake = createFakeContext('map_cancel:1');
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleMapCancel(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('Invalid session'))).toBe(true);
      expect(fake.edits).toHaveLength(0);
    });

    it('rejects wrong action token (auto_map token with map_cancel)', async () => {
      const autoPending = pendingMappingStore.createAutoMap({
        chatId: '-1001234567890',
        userId: '12345678',
        inventoryGeneration: 1,
        decisions: [],
      });

      const fake = createFakeContext(`map_cancel:${autoPending.id}:1`);
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleMapCancel(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('Invalid session type'))).toBe(true);
    });

    it('rejects token belonging to different user', async () => {
      const pending = pendingMappingStore.createMap({
        chatId: '-1001234567890',
        userId: '12345678',
        inventoryGeneration: 1,
        customerId: 1,
        prtgObjectId: 100,
        expectedCustomer: { id: 1, clientId: 'c1', name: 'Customer 1', enabled: true, monitorType: 'prtg' },
        expectedSensor: { objectId: 100, deviceName: 'Device1', sensorName: 'Sensor1', sensorType: 'Ping' },
      });

      const fake = createFakeContext(`map_cancel:${pending.id}:1`, { userId: 99999999 });
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleMapCancel(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('Unauthorized'))).toBe(true);
    });

    it('rejects unknown token', async () => {
      const fake = createFakeContext('map_cancel:unknown-token:1');
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleMapCancel(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('not found') || a.includes('expired'))).toBe(true);
    });

    it('cancels valid map session and invalidates token', async () => {
      const pending = pendingMappingStore.createMap({
        chatId: '-1001234567890',
        userId: '12345678',
        inventoryGeneration: 1,
        customerId: 1,
        prtgObjectId: 100,
        expectedCustomer: { id: 1, clientId: 'c1', name: 'Customer 1', enabled: true, monitorType: 'prtg' },
        expectedSensor: { objectId: 100, deviceName: 'Device1', sensorName: 'Sensor1', sensorType: 'Ping' },
      });

      const fake = createFakeContext(`map_cancel:${pending.id}:1`, { userId: 12345678, chatId: -1001234567890 });
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleMapCancel(makeFakeBotContext(fake));

      expect(pendingMappingStore.get(pending.id)).toBeUndefined();
      expect(fake.answers.some(a => a.includes('Cancelled'))).toBe(true);
    });
  });

  describe('handleAutoMapCancel', () => {
    it('rejects auto_cancel with map action token', async () => {
      const mapPending = pendingMappingStore.createMap({
        chatId: '-1001234567890',
        userId: '12345678',
        inventoryGeneration: 1,
        customerId: 1,
        prtgObjectId: 100,
        expectedCustomer: { id: 1, clientId: 'c1', name: 'Customer 1', enabled: true, monitorType: 'prtg' },
        expectedSensor: { objectId: 100, deviceName: 'Device1', sensorName: 'Sensor1', sensorType: 'Ping' },
      });

      const fake = createFakeContext(`auto_cancel:${mapPending.id}`);
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleAutoMapCancel(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('Invalid session type'))).toBe(true);
      expect(fake.edits.some(e => e.text.includes('cancelled'))).toBe(false);
    });

    it('rejects auto_cancel with unknown token', async () => {
      const fake = createFakeContext('auto_cancel:nonexistent');
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleAutoMapCancel(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('not found') || a.includes('expired'))).toBe(true);
    });

    it('rejects auto_cancel from non-admin', async () => {
      const fake = createFakeContext('auto_cancel:some-token');
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(false);

      await handleAutoMapCancel(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('Admin') || a.includes('admin'))).toBe(true);
    });

    it('cancels valid auto_map session', async () => {
      const autoPending = pendingMappingStore.createAutoMap({
        chatId: '-1001234567890',
        userId: '12345678',
        inventoryGeneration: 1,
        decisions: [],
      });

      const fake = createFakeContext(`auto_cancel:${autoPending.id}`, { userId: 12345678, chatId: -1001234567890 });
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleAutoMapCancel(makeFakeBotContext(fake));

      expect(pendingMappingStore.get(autoPending.id)).toBeUndefined();
      expect(fake.answers.some(a => a.includes('Cancelled'))).toBe(true);
    });
  });

  describe('handleUnmapCancel', () => {
    it('rejects unmap_cancel with map action token', async () => {
      const mapPending = pendingMappingStore.createMap({
        chatId: '-1001234567890',
        userId: '12345678',
        inventoryGeneration: 1,
        customerId: 1,
        prtgObjectId: 100,
        expectedCustomer: { id: 1, clientId: 'c1', name: 'Customer 1', enabled: true, monitorType: 'prtg' },
        expectedSensor: { objectId: 100, deviceName: 'Device1', sensorName: 'Sensor1', sensorType: 'Ping' },
      });

      const fake = createFakeContext(`unmap_cancel:${mapPending.id}`);
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleUnmapCancel(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('Invalid session type'))).toBe(true);
      expect(fake.edits.some(e => e.text.includes('cancelled'))).toBe(false);
    });

    it('rejects unmap_cancel with unknown token', async () => {
      const fake = createFakeContext('unmap_cancel:nonexistent');
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleUnmapCancel(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('not found') || a.includes('expired'))).toBe(true);
    });

    it('cancels valid unmap session', async () => {
      const unmapPending = pendingMappingStore.createUnmap({
        chatId: '-1001234567890',
        userId: '12345678',
        inventoryGeneration: 1,
        customerId: 1,
        mappingId: 5,
        expectedMapping: { customerId: 1, prtgObjectId: 100, mappingMethod: 'manual', verified: false },
      });

      const fake = createFakeContext(`unmap_cancel:${unmapPending.id}`, { userId: 12345678, chatId: -1001234567890 });
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleUnmapCancel(makeFakeBotContext(fake));

      expect(pendingMappingStore.get(unmapPending.id)).toBeUndefined();
      expect(fake.answers.some(a => a.includes('Cancelled'))).toBe(true);
    });
  });

  describe('handleMapSearch', () => {
    it('rejects search callback from non-admin', async () => {
      const searchSession = pendingMappingStore.createSearch({
        chatId: '-1001234567890',
        userId: '12345678',
        inventoryGeneration: 1,
        customerId: 1,
        page: 1,
        candidates: [{ objectId: 100, deviceName: 'Device1', sensorName: 'Sensor1', sensorType: 'Ping' }],
      });

      const fake = createFakeContext(`map_search:${searchSession.id}:1`, { userId: 12345678, chatId: -1001234567890 });
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(false);

      await handleMapSearch(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('Admin') || a.includes('admin'))).toBe(true);
      expect(fake.edits).toHaveLength(0);
    });

    it('rejects search callback with nonexistent customer', async () => {
      const searchSession = pendingMappingStore.createSearch({
        chatId: '-1001234567890',
        userId: '12345678',
        inventoryGeneration: 1,
        customerId: 1,
        page: 1,
        candidates: [{ objectId: 100, deviceName: 'Device1', sensorName: 'Sensor1', sensorType: 'Ping' }],
      });

      const fake = createFakeContext(`map_search:${searchSession.id}:999999`, { userId: 12345678, chatId: -1001234567890 });
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);
      vi.spyOn(customerService, 'getById').mockReturnValue(undefined);

      await handleMapSearch(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('not found') || a.includes('mismatch'))).toBe(true);
    });
  });

  describe('handleSearchPagination', () => {
    it('rejects pagination with nonexistent session', async () => {
      const fake = createFakeContext('search_page:nonexistent-session:1');
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleSearchPagination(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('expired') || a.includes('invalid'))).toBe(true);
    });

    it('rejects pagination from different user', async () => {
      const searchSession = pendingMappingStore.createSearch({
        chatId: '-1001234567890',
        userId: '12345678',
        inventoryGeneration: 1,
        customerId: 1,
        page: 1,
        candidates: [{ objectId: 100, deviceName: 'Device1', sensorName: 'Sensor1', sensorType: 'Ping' }],
      });

      const fake = createFakeContext(`search_page:${searchSession.id}:1`, { userId: 99999999, chatId: -1001234567890 });
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleSearchPagination(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('Unauthorized'))).toBe(true);
    });

    it('rejects pagination from different chat', async () => {
      const searchSession = pendingMappingStore.createSearch({
        chatId: '-1001234567890',
        userId: '12345678',
        inventoryGeneration: 1,
        customerId: 1,
        page: 1,
        candidates: [{ objectId: 100, deviceName: 'Device1', sensorName: 'Sensor1', sensorType: 'Ping' }],
      });

      const fake = createFakeContext(`search_page:${searchSession.id}:1`, { chatId: -999999999999 });
      vi.spyOn(accessService, 'canManageMappings').mockReturnValue(true);

      await handleSearchPagination(makeFakeBotContext(fake));

      expect(fake.answers.some(a => a.includes('Unauthorized'))).toBe(true);
    });
  });
});