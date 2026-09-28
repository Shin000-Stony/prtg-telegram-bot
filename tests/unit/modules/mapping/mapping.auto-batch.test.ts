import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MappingService } from '@/modules/mapping/mapping.service';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import {
  InventorySnapshot,
  PrtgInventoryCache,
} from '@/integrations/prtg/prtg.inventory.cache';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { customerRepository } from '@/modules/customers/customer.repository';

const adminContext = { userId: 'admin123', chatId: 'chat123', chatType: 'private' };

function makeSensor(over: Partial<InventorySnapshot['sensors'][0]> = {}): InventorySnapshot['sensors'][0] {
  return {
    objectId: 1001,
    deviceName: 'Server-1001',
    sensorName: 'Ping',
    sensorType: 'Ping',
    statusRaw: 3,
    statusDisplay: 'Up',
    statusMessage: null,
    lastValue: null,
    lastUp: null,
    lastDown: null,
    ...over,
  };
}

function makeInventory(sensors: InventorySnapshot['sensors']): InventorySnapshot {
  return {
    sensors,
    devices: [],
    generation: 1,
    fetchedAt: new Date().toISOString(),
  };
}

describe('R4: AUTO batch atomicity', () => {
  let service: MappingService;

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin123');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');

    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();

    service = new MappingService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
    vi.restoreAllMocks();
  });

  describe('previewAutoMapping shared-target conflict resolution', () => {
    it('two customers / one sensor: both become suggestions, none automatic', () => {
      customerRepository.bulkCreate([
        { clientId: '001234', name: 'Customer A', monitorType: 'prtg', pingHost: null, enabled: true },
        { clientId: '001235', name: 'Customer B', monitorType: 'prtg', pingHost: null, enabled: true },
      ]);

      const inventory = makeInventory([
        makeSensor({ objectId: 4036, deviceName: 'Device-001234-001235', sensorName: 'Ping', sensorType: 'Ping' }),
      ]);

      const result = service.previewAutoMapping(adminContext, inventory);

      expect(result.preview.automatic).toHaveLength(0);
      expect(result.preview.suggestions).toHaveLength(2);
    });

    it('three customers / one sensor: none automatic, all suggestions', () => {
      customerRepository.bulkCreate([
        { clientId: '001234', name: 'Customer A', monitorType: 'prtg', pingHost: null, enabled: true },
        { clientId: '001235', name: 'Customer B', monitorType: 'prtg', pingHost: null, enabled: true },
        { clientId: '001236', name: 'Customer C', monitorType: 'prtg', pingHost: null, enabled: true },
      ]);

      const inventory = makeInventory([
        makeSensor({ objectId: 4036, deviceName: 'Dev-001234-001235-001236', sensorName: 'Ping', sensorType: 'Ping' }),
      ]);

      const result = service.previewAutoMapping(adminContext, inventory);

      expect(result.preview.automatic).toHaveLength(0);
      expect(result.preview.suggestions).toHaveLength(3);
    });

    it('conflict detection is order-independent', () => {
      customerRepository.bulkCreate([
        { clientId: '001235', name: 'Customer B', monitorType: 'prtg', pingHost: null, enabled: true },
        { clientId: '001234', name: 'Customer A', monitorType: 'prtg', pingHost: null, enabled: true },
      ]);

      const inventory = makeInventory([
        makeSensor({ objectId: 4036, deviceName: 'Device-001234-001235', sensorName: 'Ping', sensorType: 'Ping' }),
      ]);

      const result = service.previewAutoMapping(adminContext, inventory);

      expect(result.preview.automatic).toHaveLength(0);
      expect(result.preview.suggestions).toHaveLength(2);
    });

    it('single-customer preview still checks ALL eligible customers for conflicts', () => {
      customerRepository.bulkCreate([
        { clientId: '001234', name: 'Customer A', monitorType: 'prtg', pingHost: null, enabled: true },
        { clientId: '001235', name: 'Customer B', monitorType: 'prtg', pingHost: null, enabled: true },
      ]);

      const inventory = makeInventory([
        makeSensor({ objectId: 4036, deviceName: 'Device-001234-001235', sensorName: 'Ping', sensorType: 'Ping' }),
      ]);

      const result = service.previewAutoMapping(adminContext, inventory, '001234');

      expect(result.preview.automatic).toHaveLength(0);
      expect(result.preview.suggestions).toHaveLength(1);
    });

    it('single-customer preview for unique match: one automatic, no conflict', () => {
      customerRepository.bulkCreate([
        { clientId: '999999', name: 'Unique Customer', monitorType: 'prtg', pingHost: null, enabled: true },
      ]);

      const inventory = makeInventory([
        makeSensor({ objectId: 4036, deviceName: 'Device-999999', sensorName: 'Ping', sensorType: 'Ping' }),
      ]);

      const result = service.previewAutoMapping(adminContext, inventory, '999999')!;

      expect(result.preview.automatic).toHaveLength(1);
      expect(result.preview.automatic[0].objectId).toBe(4036);
    });
  });

  describe('applyAutoMapping atomicity', () => {
    it('failed apply does zero writes when preconditions change after preview', () => {
      customerRepository.bulkCreate([
        { clientId: '001234', name: 'Customer A', monitorType: 'prtg', pingHost: null, enabled: true },
      ]);

      const inventory = makeInventory([
        makeSensor({ objectId: 4036, deviceName: 'Device-001234', sensorName: 'Ping', sensorType: 'Ping' }),
      ]);

      const { token } = service.previewAutoMapping(adminContext, inventory, '001234')!;

      const changedInventory = makeInventory([
        makeSensor({ objectId: 9999, deviceName: 'Device-999999', sensorName: 'Ping', sensorType: 'Ping' }),
      ]);

      expect(() =>
        service.applyAutoMapping(adminContext, token, changedInventory)
      ).toThrow();

      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(0);
      // Token must be retained after validation failure (no writes)
      expect(pendingMappingStore.get(token)).toBeDefined();
    });

    it('forced insert failure → token retained, no writes', () => {
      vi.spyOn(mappingRepository, 'createInTransaction').mockImplementationOnce(() => {
        throw new Error('DB insert failed');
      });

      customerRepository.bulkCreate([
        { clientId: '001234', name: 'Customer A', monitorType: 'prtg', pingHost: null, enabled: true },
      ]);

      const inventory = makeInventory([
        makeSensor({ objectId: 4036, deviceName: 'Device-001234', sensorName: 'Ping', sensorType: 'Ping' }),
      ]);

      const { token } = service.previewAutoMapping(adminContext, inventory, '001234')!;

      expect(() => service.applyAutoMapping(adminContext, token, inventory)).toThrow('DB insert failed');

      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(0);
      // Token must be retained after transaction failure
      expect(pendingMappingStore.get(token)).toBeDefined();
    });

    it('stale inventory rejected in AUTO apply', () => {
      customerRepository.bulkCreate([
        { clientId: '001234', name: 'Customer A', monitorType: 'prtg', pingHost: null, enabled: true },
      ]);

      const inventory = makeInventory([
        makeSensor({ objectId: 4036, deviceName: 'Device-001234', sensorName: 'Ping', sensorType: 'Ping' }),
      ]);

      const { token } = service.previewAutoMapping(adminContext, inventory, '001234')!;

      const staleInventory: InventorySnapshot = {
        ...inventory,
        fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      };

      expect(() => service.applyAutoMapping(adminContext, token, staleInventory)).toThrow('stale');

      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(0);
    });

    it('successful apply consumes token', () => {
      customerRepository.bulkCreate([
        { clientId: '001234', name: 'Customer A', monitorType: 'prtg', pingHost: null, enabled: true },
      ]);

      const inventory = makeInventory([
        makeSensor({ objectId: 4036, deviceName: 'Device-001234', sensorName: 'Ping', sensorType: 'Ping' }),
      ]);

      const { token } = service.previewAutoMapping(adminContext, inventory, '001234')!;
      const created = service.applyAutoMapping(adminContext, token, inventory);

      expect(created).toHaveLength(1);
      expect(created[0].mappingMethod).toBe('auto');
      expect(created[0].verified).toBe(false);
      // Token must be consumed after successful apply
      expect(pendingMappingStore.get(token)).toBeUndefined();
    });

    it('replay after successful apply does not write again', () => {
      customerRepository.bulkCreate([
        { clientId: '001234', name: 'Customer A', monitorType: 'prtg', pingHost: null, enabled: true },
      ]);

      const inventory = makeInventory([
        makeSensor({ objectId: 4036, deviceName: 'Device-001234', sensorName: 'Ping', sensorType: 'Ping' }),
      ]);

      const { token } = service.previewAutoMapping(adminContext, inventory, '001234')!;
      service.applyAutoMapping(adminContext, token, inventory);

      expect(() => service.applyAutoMapping(adminContext, token, inventory)).toThrow('Invalid or expired');

      const mappings = mappingRepository.findAll();
      expect(mappings).toHaveLength(1);
    });
  });
});
