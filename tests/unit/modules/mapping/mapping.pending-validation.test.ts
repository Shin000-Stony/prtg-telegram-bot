import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MappingService } from '@/modules/mapping/mapping.service';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { customerService } from '@/modules/customers/customer.service';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { customerRepository } from '@/modules/customers/customer.repository';
import type { InventorySnapshot } from '@/integrations/prtg/prtg.inventory.cache';

describe('R3: Pending action validation', () => {
  let service: MappingService;

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin123,user2');
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

    customerRepository.bulkCreate([
      { clientId: 'TEST001', name: 'Test Customer', monitorType: 'prtg', pingHost: 'test.example.com', enabled: true },
    ]);

    service = new MappingService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
  });

  const adminContext = { userId: 'admin123', chatId: 'chat123', chatType: 'private' };

  function makeInventory(sensors?: InventorySnapshot['sensors']): InventorySnapshot {
    return {
      sensors: sensors ?? [{ objectId: 4036, deviceName: 'Dev', sensorName: 'Ping', sensorType: 'Ping', statusRaw: 3, statusDisplay: 'Up', statusMessage: 'Up', lastValue: null, lastUp: null, lastDown: null }],
      devices: [],
      generation: 1,
      fetchedAt: new Date().toISOString(),
    };
  }

  describe('confirmMapping token validation', () => {
    it('rejects invalid/non-existent token', () => {
      expect(() =>
        service.confirmMapping({
          clientId: 'TEST001',
          objectId: 4036,
          operatorId: 'admin123',
          context: adminContext,
          token: 'nonexistent-token',
          inventory: makeInventory(),
        })
      ).toThrow('Invalid or expired');
    });

    it('rejects token belonging to different user', () => {
      const pending = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());

      expect(() =>
        service.confirmMapping({
          clientId: 'TEST001',
          objectId: 4036,
          operatorId: 'user2',
          context: { userId: 'user2', chatId: 'chat123', chatType: 'private' },
          token: pending.token,
          inventory: makeInventory(),
        })
      ).toThrow('different user');

      expect(pendingMappingStore.get(pending.token)).toBeDefined();
    });

    it('rejects token belonging to different chat', () => {
      const pending = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());

      expect(() =>
        service.confirmMapping({
          clientId: 'TEST001',
          objectId: 4036,
          operatorId: 'admin123',
          context: { userId: 'admin123', chatId: 'different-chat', chatType: 'private' },
          token: pending.token,
          inventory: makeInventory(),
        })
      ).toThrow('different chat');

      expect(pendingMappingStore.get(pending.token)).toBeDefined();
    });

    it('rejects mismatched objectId not in pending', () => {
      const pending = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());

      expect(() =>
        service.confirmMapping({
          clientId: 'TEST001',
          objectId: 9999,
          operatorId: 'admin123',
          context: adminContext,
          token: pending.token,
          inventory: makeInventory(),
        })
      ).toThrow('does not match');

      expect(pendingMappingStore.get(pending.token)).toBeDefined();
    });

    it('rejects confirm when inventory generation has changed', () => {
      const pending = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());

      expect(() =>
        service.confirmMapping({
          clientId: 'TEST001',
          objectId: 4036,
          operatorId: 'admin123',
          context: adminContext,
          token: pending.token,
          inventory: {
            ...makeInventory(),
            generation: 2,
          },
        })
      ).toThrow('Inventory has changed');

      expect(pendingMappingStore.get(pending.token)).toBeDefined();
    });
  });

  describe('token consumption behavior', () => {
    it('does not consume token on validation failure', () => {
      const pending = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());

      expect(() =>
        service.confirmMapping({
          clientId: 'TEST001',
          objectId: 9999,
          operatorId: 'admin123',
          context: adminContext,
          token: pending.token,
          inventory: makeInventory(),
        })
      ).toThrow();

      expect(pendingMappingStore.get(pending.token)).toBeDefined();
    });

    it('consumes token on successful write', () => {
      const pending = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());

      const mapping = service.confirmMapping({
        clientId: 'TEST001',
        objectId: 4036,
        operatorId: 'admin123',
        context: adminContext,
        token: pending.token,
        inventory: makeInventory(),
      });

      expect(mapping).toBeDefined();
      expect(mapping.verified).toBe(true);
      expect(mapping.mappingMethod).toBe('manual');
      expect(pendingMappingStore.get(pending.token)).toBeUndefined();
    });

    it('does not consume token when DB write fails', () => {
      vi.spyOn(mappingRepository, 'create').mockImplementationOnce(() => {
        throw new Error('DB write failed');
      });

      const pending = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());

      expect(() =>
        service.confirmMapping({
          clientId: 'TEST001',
          objectId: 4036,
          operatorId: 'admin123',
          context: adminContext,
          token: pending.token,
          inventory: makeInventory(),
        })
      ).toThrow('DB write failed');

      expect(pendingMappingStore.get(pending.token)).toBeDefined();
    });

    it('rejects stale inventory in manual confirm', () => {
      const pending = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());

      const staleInventory: InventorySnapshot = {
        ...makeInventory(),
        fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      };

      expect(() =>
        service.confirmMapping({
          clientId: 'TEST001',
          objectId: 4036,
          operatorId: 'admin123',
          context: adminContext,
          token: pending.token,
          inventory: staleInventory,
        })
      ).toThrow('stale');

      expect(pendingMappingStore.get(pending.token)).toBeDefined();
    });

    it('rejects when sensor removed from inventory since preview', () => {
      const pending = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());

      const inventoryWithoutSensor = makeInventory([
        { objectId: 9999, deviceName: 'Other', sensorName: 'Ping', sensorType: 'Ping', statusRaw: 3, statusDisplay: 'Up', statusMessage: null, lastValue: null, lastUp: null, lastDown: null },
      ]);

      expect(() =>
        service.confirmMapping({
          clientId: 'TEST001',
          objectId: 4036,
          operatorId: 'admin123',
          context: adminContext,
          token: pending.token,
          inventory: inventoryWithoutSensor,
        })
      ).toThrow('Sensor not found');

      expect(pendingMappingStore.get(pending.token)).toBeDefined();
    });

    it('rejects when sensor identity changed since preview', () => {
      const pending = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());

      // Sensor exists but has different identity (renamed)
      const changedInventory = makeInventory([
        { objectId: 4036, deviceName: 'Different-Device', sensorName: 'DifferentSensor', sensorType: 'Ping', statusRaw: 3, statusDisplay: 'Up', statusMessage: null, lastValue: null, lastUp: null, lastDown: null },
      ]);

      expect(() =>
        service.confirmMapping({
          clientId: 'TEST001',
          objectId: 4036,
          operatorId: 'admin123',
          context: adminContext,
          token: pending.token,
          inventory: changedInventory,
        })
      ).toThrow('Sensor details have changed');

      expect(pendingMappingStore.get(pending.token)).toBeDefined();
    });

    it('handles double-click by consuming token atomically', () => {
      const pending = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());

      // First confirmation should succeed
      service.confirmMapping({
        clientId: 'TEST001',
        objectId: 4036,
        operatorId: 'admin123',
        context: adminContext,
        token: pending.token,
        inventory: makeInventory(),
      });

      // Second confirmation should fail (token already consumed)
      expect(() =>
        service.confirmMapping({
          clientId: 'TEST001',
          objectId: 4036,
          operatorId: 'admin123',
          context: adminContext,
          token: pending.token,
          inventory: makeInventory(),
        })
      ).toThrow('Invalid or expired');
    });
  });

  describe('AUTO verification flow', () => {
    it('prepareMapping allows verification of existing AUTO mapping to same sensor', () => {
      const customer = customerService.getByClientId('TEST001');
      expect(customer).toBeDefined();

      // Create an AUTO mapping (unverified)
      mappingRepository.create({
        customerId: customer!.id,
        prtgObjectId: 4036,
        prtgDeviceName: 'Dev',
        prtgSensorName: 'Ping',
        mappingMethod: 'auto',
        verified: false,
        mappedByTelegramId: 'admin123',
      });

      // prepareMapping should allow this (not throw "Customer already has a mapping")
      const { token, preview } = service.prepareMapping('TEST001', 4036, adminContext, makeInventory());
      expect(token).toBeDefined();
      expect(preview.existingMapping).toBeDefined();
    });

    it('prepareMapping rejects verification of AUTO mapping to different sensor', () => {
      const customer = customerService.getByClientId('TEST001');
      expect(customer).toBeDefined();

      // Create an AUTO mapping to sensor 4036
      mappingRepository.create({
        customerId: customer!.id,
        prtgObjectId: 4036,
        prtgDeviceName: 'Dev',
        prtgSensorName: 'Ping',
        mappingMethod: 'auto',
        verified: false,
        mappedByTelegramId: 'admin123',
      });

      // Trying to prepare mapping to a DIFFERENT sensor should be rejected
      expect(() => service.prepareMapping('TEST001', 9999, adminContext, makeInventory())).toThrow('Customer already has a mapping');
    });

    it('prepareMapping rejects existing manual mapping', () => {
      const customer = customerService.getByClientId('TEST001');
      expect(customer).toBeDefined();

      mappingRepository.create({
        customerId: customer!.id,
        prtgObjectId: 4036,
        prtgDeviceName: 'Dev',
        prtgSensorName: 'Ping',
        mappingMethod: 'manual',
        verified: true,
        mappedByTelegramId: 'admin123',
      });

      expect(() => service.prepareMapping('TEST001', 4036, adminContext, makeInventory())).toThrow('Customer already has a mapping');
    });
  });
});
