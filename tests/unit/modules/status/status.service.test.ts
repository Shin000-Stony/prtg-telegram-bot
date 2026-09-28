import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { StatusService } from '@/modules/status/status.service';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import { accessService, AccessContext } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { setPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { resetConfigForTesting } from '@/config/env';
import { customerRepository } from '@/modules/customers/customer.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import type { InventorySnapshot } from '@/integrations/prtg/prtg.inventory.cache';

const adminUserId = 'admin1';
const foreignAdminUserId = 'admin2';
const nonAdminUserId = '99999999';
const globalGroupId = '-1001234567890';
const ordinaryGroupId = '-100999';

function makeSnapshot(
  sensors: Array<{ objectId: number; sensorType: string; statusRaw: number; lastValue?: string }>,
  generation = 1,
): InventorySnapshot {
  return {
    sensors: sensors.map(s => ({
      objectId: s.objectId,
      deviceName: 'Device-A',
      sensorName: 'Ping',
      sensorType: s.sensorType,
      statusRaw: s.statusRaw,
      statusDisplay: `Status ${s.statusRaw}`,
      statusMessage: null,
      lastValue: s.lastValue ?? null,
      lastUp: null,
      lastDown: null,
    })),
    devices: [],
    generation,
    fetchedAt: new Date().toISOString(),
  };
}

function makeCache(snap: InventorySnapshot | null, stale: InventorySnapshot | null) {
  return {
    getFresh: () => snap,
    getStale: () => stale,
    isFresh: () => snap !== null,
    isStale: () => stale !== null,
    isExpired: () => snap === null,
    hasAnySnapshot: () => snap !== null || stale !== null,
  };
}

describe('StatusService - authorization', () => {
  let service: StatusService;

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
      { clientId: 'client3', name: 'PIC Customer', monitorType: 'pic', pingHost: null, enabled: true },
      { clientId: 'client4', name: 'Disabled Customer', monitorType: 'prtg', pingHost: null, enabled: false },
    ]);

    groupRepository.upsert(globalGroupId, 'Global');
    groupRepository.upsert(ordinaryGroupId, 'Ordinary');

    const c1 = customerService.getByClientId('client1');
    const c2 = customerService.getByClientId('client2');
    if (!c1 || !c2) throw new Error('Customers not found');
    groupRepository.assignCustomer({ groupChatId: ordinaryGroupId, customerId: c1.id, canView: true, receiveAlerts: false });

    service = new StatusService();

    vi.restoreAllMocks();

    vi.spyOn(accessService, 'isAdmin').mockImplementation((userId: string) => {
      return userId === adminUserId || userId === foreignAdminUserId;
    });
    vi.spyOn(accessService, 'isPrivateChat').mockImplementation((chatType: string) => {
      return chatType === 'private';
    });
    vi.spyOn(accessService, 'isGroupChat').mockImplementation((chatType: string) => {
      return chatType === 'group' || chatType === 'supergroup';
    });
    vi.spyOn(accessService, 'isGlobalGroup').mockImplementation((chatId: string) => {
      return chatId === globalGroupId;
    });
    vi.spyOn(accessService, 'isGroupRegistered').mockImplementation((chatId: string) => {
      return chatId === globalGroupId || chatId === ordinaryGroupId;
    });
    vi.spyOn(accessService, 'getCustomerAccessScope').mockImplementation((ctx: AccessContext) => {
      if (accessService.isPrivateChat(ctx.chatType)) {
        if (accessService.isAdmin(ctx.userId)) return { kind: 'all' };
        return { kind: 'none' };
      }
      if (accessService.isGlobalGroup(ctx.chatId)) return { kind: 'all' };
      if (accessService.isGroupRegistered(ctx.chatId)) {
        return { kind: 'assigned', customerIds: groupRepository.getCustomerIdsWithAccess(ctx.chatId, false) };
      }
      return { kind: 'none' };
    });
    vi.spyOn(accessService, 'canViewCustomer').mockImplementation((ctx: AccessContext, customerId: number) => {
      const scope = accessService.getCustomerAccessScope(ctx);
      if (scope.kind === 'all') return true;
      if (scope.kind === 'none') return false;
      return scope.customerIds.includes(customerId);
    });
    vi.spyOn(accessService, 'canManageMappings').mockImplementation((ctx: AccessContext) => {
      return accessService.isAdmin(ctx.userId) && (accessService.isPrivateChat(ctx.chatType) || accessService.isGlobalGroup(ctx.chatId));
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('getCustomerStatus', () => {
    it('private non-admin → denied (scope_none)', () => {
      const ctx = { userId: nonAdminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.getCustomerStatus(ctx, 'client1');
      expect(result.status).toBe('UNKNOWN');
      expect(result.reason).toBe('unknown');
    });

    it('private admin with mapping + fresh sensor UP', () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 3 }]);
      setPrtgInventoryCache(makeCache(snap, null) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.getCustomerStatus(ctx, 'client1');
      expect(result.status).toBe('UP');
      expect(result.dataQuality).toBe('fresh');
    });

    it('global non-admin (read) → can view', () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
      setPrtgInventoryCache(makeCache(snap, null) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: nonAdminUserId, chatId: globalGroupId, chatType: 'supergroup' };
      const result = service.getCustomerStatus(ctx, 'client1');
      expect(result.status).toBe('DOWN');
      expect(result.dataQuality).toBe('fresh');
    });

    it('ordinary assigned non-admin (read) → can view assigned, denied for unassigned', () => {
      const customer1 = customerService.getByClientId('client1');
      const customer2 = customerService.getByClientId('client2');
      if (!customer1 || !customer2) throw new Error('Customers not found');
      mappingRepository.create({
        customerId: customer1.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 3 }]);
      setPrtgInventoryCache(makeCache(snap, null) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const assignedCtx = { userId: nonAdminUserId, chatId: ordinaryGroupId, chatType: 'supergroup' };
      const assignedResult = service.getCustomerStatus(assignedCtx, 'client1');
      expect(assignedResult.status).toBe('UP');

      const unassignedResult = service.getCustomerStatus(assignedCtx, 'client2');
      expect(unassignedResult.status).toBe('UNKNOWN');
      expect(unassignedResult.reason).toBe('unknown');
    });

    it('unregistered group → denied', () => {
      const snap = makeSnapshot([]);
      setPrtgInventoryCache(makeCache(snap, null) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: nonAdminUserId, chatId: '-100999888', chatType: 'supergroup' };
      const result = service.getCustomerStatus(ctx, 'client1');
      expect(result.status).toBe('UNKNOWN');
      expect(result.reason).toBe('unknown');
    });

    it('disabled customer → DISABLED', () => {
      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.getCustomerStatus(ctx, 'client4');
      expect(result.status).toBe('DISABLED');
      expect(result.dataQuality).toBe('not_applicable');
    });

    it('PIC customer → PIC_MANAGED', () => {
      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.getCustomerStatus(ctx, 'client3');
      expect(result.status).toBe('PIC_MANAGED');
    });

    it('stale snapshot → effective UNKNOWN with lastKnownStatus as info', () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const freshDown = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
      const staleSnap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
      setPrtgInventoryCache(makeCache(null, staleSnap) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.getCustomerStatus(ctx, 'client1');
      expect(result.status).toBe('UNKNOWN');
      expect(result.dataQuality).toBe('stale');
      expect(result.lastKnownStatus).toBe('DOWN');
    });

    it('unmapped customer → UNMAPPED not_applicable', () => {
      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.getCustomerStatus(ctx, 'client2');
      expect(result.status).toBe('UNMAPPED');
      expect(result.dataQuality).toBe('not_applicable');
    });
  });

  describe('getSummary', () => {
    it('private non-admin → empty summary', () => {
      const ctx = { userId: nonAdminUserId, chatId: 'private_chat', chatType: 'private' };
      const summary = service.getSummary(ctx);
      expect(summary.total).toBe(0);
    });

    it('private admin sees all customers with correct per-customer quality', async () => {
      const c1 = customerService.getByClientId('client1');
      const c2 = customerService.getByClientId('client2');
      if (!c1 || !c2) throw new Error('Customers not found');
      mappingRepository.create({
        customerId: c1.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });
      mappingRepository.create({
        customerId: c2.id,
        prtgObjectId: 2001,
        prtgDeviceName: 'Device-B',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const snap = makeSnapshot([
        { objectId: 1001, sensorType: 'Ping', statusRaw: 3 },
        { objectId: 2001, sensorType: 'Ping', statusRaw: 4 },
      ]);
      setPrtgInventoryCache(makeCache(snap, null) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const summary = service.getSummary(ctx);

      expect(summary.total).toBe(4);
      const buckets = Object.fromEntries(summary.buckets.map(b => [b.status, b.count]));
      expect(buckets.UP).toBe(1);
      expect(buckets.WARNING).toBe(1);
      expect(buckets.DISABLED).toBe(1);
      expect(buckets.PIC_MANAGED).toBe(1);
      expect(summary.dataQuality.fresh).toBe(2);
      expect(summary.dataQuality.notApplicable).toBe(2);
    });

    it('unavailable inventory → mapped PRTG counted as unavailable', async () => {
      const c1 = customerService.getByClientId('client1');
      const c2 = customerService.getByClientId('client2');
      if (!c1 || !c2) throw new Error('Customers not found');
      mappingRepository.create({
        customerId: c1.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });
      mappingRepository.create({
        customerId: c2.id,
        prtgObjectId: 2001,
        prtgDeviceName: 'Device-B',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      setPrtgInventoryCache(makeCache(null, null) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const summary = service.getSummary(ctx);

      const buckets = Object.fromEntries(summary.buckets.map(b => [b.status, b.count]));
      expect(buckets.UNKNOWN).toBe(2);
      expect(summary.dataQuality.unavailable).toBe(2);
      expect(summary.dataQuality.notApplicable).toBe(2);
    });

    it('stale data → correct quality counts per customer', async () => {
      const c1 = customerService.getByClientId('client1');
      const c2 = customerService.getByClientId('client2');
      if (!c1 || !c2) throw new Error('Customers not found');
      mappingRepository.create({
        customerId: c1.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });
      mappingRepository.create({
        customerId: c2.id,
        prtgObjectId: 2001,
        prtgDeviceName: 'Device-B',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const staleSnap = makeSnapshot([
        { objectId: 1001, sensorType: 'Ping', statusRaw: 5 },
        { objectId: 2001, sensorType: 'Ping', statusRaw: 3 },
      ]);
      setPrtgInventoryCache(makeCache(null, staleSnap) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const summary = service.getSummary(ctx);

      expect(summary.dataQuality.stale).toBe(2);
      expect(summary.dataQuality.notApplicable).toBe(2);
      const buckets = Object.fromEntries(summary.buckets.map(b => [b.status, b.count]));
      expect(buckets.UNKNOWN).toBe(2);
    });
  });

  describe('listDown', () => {
    it('private non-admin → empty list', () => {
      const ctx = { userId: nonAdminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.listDown(ctx, 1);
      expect(result.total).toBe(0);
    });

    it('fresh DOWN appears on /down', () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const snap = makeSnapshot([
        { objectId: 1001, sensorType: 'Ping', statusRaw: 5 },
        { objectId: 2001, sensorType: 'Ping', statusRaw: 3 },
      ]);
      setPrtgInventoryCache(makeCache(snap, null) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.listDown(ctx, 1);
      expect(result.total).toBe(1);
      expect(result.items[0].clientId).toBe('client1');
      expect(result.dataQuality).toBe('fresh');
      expect(result.uncertainCount).toBe(0);
    });

    it('stale DOWN does NOT appear in /down, uncertainCount shows', () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const staleSnap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
      setPrtgInventoryCache(makeCache(null, staleSnap) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.listDown(ctx, 1);
      expect(result.total).toBe(0);
      expect(result.uncertainCount).toBe(1);
      expect(result.dataQuality).toBe('stale');
    });

    it('stale DOWN does NOT appear in /down, uncertainCount shows', () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const staleSnap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
      setPrtgInventoryCache(makeCache(null, staleSnap) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.listDown(ctx, 1);
      expect(result.total).toBe(0);
      expect(result.uncertainCount).toBe(1);
      expect(result.dataQuality).toBe('stale');
    });

    it('fresh sensor missing → UNKNOWN, uncertainCount includes it', () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const snap = makeSnapshot([]);
      setPrtgInventoryCache(makeCache(snap, null) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.listDown(ctx, 1);
      expect(result.total).toBe(0);
      expect(result.uncertainCount).toBe(1);
      expect(result.dataQuality).toBe('fresh');
    });

    it('fresh raw1 (UNKNOWN) → uncertainCount includes it', () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 1 }]);
      setPrtgInventoryCache(makeCache(snap, null) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.listDown(ctx, 1);
      expect(result.total).toBe(0);
      expect(result.uncertainCount).toBe(1);
    });

    it('page out of range returns pageOutOfRange flag', () => {
      const customer = customerService.getByClientId('client1');
      if (!customer) throw new Error('Customer not found');
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 1001,
        prtgDeviceName: 'Device-A',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: adminUserId,
      });

      const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
      setPrtgInventoryCache(makeCache(snap, null) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);

      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.listDown(ctx, 999);
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
      expect(result.pageOutOfRange).toBe(true);
      expect(result.uncertainCount).toBe(0);
    });

    it('page=0 rejected', () => {
      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result = service.listDown(ctx, 0);
      expect(result.total).toBe(0);
      expect(result.pageOutOfRange).toBe(true);
    });
  });

  describe('listDown - >20 customers', () => {
    beforeEach(() => {
      for (let i = 100; i < 125; i++) {
        customerRepository.bulkCreate([{
          clientId: `c${i}`,
          name: `Customer ${i}`,
          monitorType: 'prtg',
          pingHost: null,
          enabled: true,
        }]);
      }

      const snap = makeSnapshot([]);
      setPrtgInventoryCache(makeCache(snap, null) as unknown as ReturnType<typeof import('@/integrations/prtg/prtg.inventory.cache').createPrtgInventoryCache>);
    });

    it('pagination works with 25 customers', () => {
      const ctx = { userId: adminUserId, chatId: 'private_chat', chatType: 'private' };
      const result1 = service.listDown(ctx, 1);
      expect(result1.totalPages).toBe(1);
      expect(result1.total).toBe(0);

      const result2 = service.listDown(ctx, 2);
      expect(result2.total).toBe(0);
      expect(result2.totalPages).toBe(1);
    });
  });
});
