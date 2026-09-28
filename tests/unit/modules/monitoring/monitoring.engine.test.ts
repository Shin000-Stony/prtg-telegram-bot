import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MonitoringEngine } from '@/modules/monitoring/monitoring.engine';
import { MonitoringRepository } from '@/modules/monitoring/monitoring.repository';
import { monitoringRepository } from '@/modules/monitoring/monitoring.repository';
import { IcmpAdapter } from '@/modules/monitoring/icmp.adapter';
import { type MonitoringConfig } from '@/modules/monitoring/monitoring.types';
import { pendingMappingStore } from '@/modules/mapping/pending-mapping.store';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { resetConfigForTesting } from '@/config/env';
import { customerRepository } from '@/modules/customers/customer.repository';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { setPrtgInventoryCache } from '@/integrations/prtg/prtg-inventory.shared';
import type { InventorySnapshot } from '@/integrations/prtg/prtg.inventory.cache';
import type { Customer } from '@/modules/customers/customer.types';
import type { PrtgMapping } from '@/modules/mapping/mapping.types';
import type { IcmpResult } from '@/modules/monitoring/icmp.adapter';

const CONFIG: MonitoringConfig = {
  enabled: true,
  prtgPollIntervalMs: 60000,
  icmpPollIntervalMs: 30000,
  icmpTimeoutMs: 3000,
  icmpConcurrency: 5,
};

function makeSnapshot(sensors: Array<{ objectId: number; sensorType: string; statusRaw: number }>): InventorySnapshot {
  return {
    sensors: sensors.map(s => ({
      objectId: s.objectId,
      deviceName: 'Device-A',
      sensorName: 'Ping',
      sensorType: s.sensorType,
      statusRaw: s.statusRaw,
      statusDisplay: `Status ${s.statusRaw}`,
      statusMessage: null,
      lastValue: null,
      lastUp: null,
      lastDown: null,
    })),
    devices: [],
    generation: 1,
    fetchedAt: new Date().toISOString(),
  } as InventorySnapshot;
}

function makeFakeCache(snap: InventorySnapshot | null, staleSnap: InventorySnapshot | null = null) {
  return {
    getFresh: () => snap,
    getStale: () => staleSnap,
    isFresh: () => snap !== null,
    isStale: () => staleSnap !== null,
    isExpired: () => snap === null && staleSnap === null,
    hasAnySnapshot: () => snap !== null || staleSnap !== null,
    forceRefresh: vi.fn().mockResolvedValue(snap ?? { sensors: [], devices: [], generation: 0, fetchedAt: new Date().toISOString() }),
  };
}

describe('MonitoringEngine', () => {
  let clock: () => number;
  let currentTime: number;
  let timers: Map<string, { cancel(): void }> = new Map();

  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    vi.stubEnv('MONITORING_ENABLED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
    pendingMappingStore.cleanup();

    customerRepository.bulkCreate([
      { clientId: 'prtg1', name: 'PRTG Customer', monitorType: 'prtg', pingHost: null, enabled: true },
      { clientId: 'prtg2', name: 'PRTG Customer 2', monitorType: 'prtg', pingHost: null, enabled: true },
      { clientId: 'icmp1', name: 'ICMP Customer', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true },
      { clientId: 'disabled', name: 'Disabled Customer', monitorType: 'prtg', pingHost: null, enabled: false },
    ]);

    currentTime = Date.now();
    clock = () => currentTime;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    timers.clear();
  });

  describe('start/stop', () => {
    it('start then stop cancels timers and prevents late writes', async () => {
      const fakeTimer = { cancel: vi.fn() };
      const fakeTimer2 = { cancel: vi.fn() };
      let callCount = 0;
      const engine = new MonitoringEngine({
        customerService: {
          listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
          getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
        },
        mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
        cache: null,
        icmpAdapter: null,
        repository: new MonitoringRepository(),
        clock,
        setTimeout: (cb, ms) => {
          callCount++;
          cb();
          return callCount === 1 ? fakeTimer : fakeTimer2;
        },
      }, CONFIG);

      engine.start();
      expect(engine.isRunning()).toBe(true);
      await engine.stop();
      expect(engine.isRunning()).toBe(false);
      expect(fakeTimer.cancel).toHaveBeenCalled();
      expect(fakeTimer2.cancel).toHaveBeenCalled();
    });

    it('start when disabled does not start', () => {
      const engine = new MonitoringEngine({
        customerService: {
          listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
          getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
        },
        mappingService: { getByCustomerId: () => null },
        cache: null,
        icmpAdapter: null,
        repository: new MonitoringRepository(),
        clock,
        setTimeout: () => ({ cancel: () => {} }),
      }, { ...CONFIG, enabled: false });

      engine.start();
      expect(engine.isRunning()).toBe(false);
    });
  });

  describe('PRTG cycle', () => {
    it('forceRefresh called exactly once per cycle when generation changes', async () => {
      const cache = makeFakeCache(makeSnapshot([
        { objectId: 1001, sensorType: 'Ping', statusRaw: 3 },
      ]));
      const c1 = customerRepository.findByClientId('prtg1');
      if (!c1) throw new Error('not found');
      mappingRepository.create({
        customerId: c1.id, prtgObjectId: 1001, prtgDeviceName: 'D', prtgSensorName: 'Ping',
        mappingMethod: 'manual', confidence: 0.95, verified: true, mappedByTelegramId: 'admin1',
      });

      const engine = new MonitoringEngine({
        customerService: {
          listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
          getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
        },
        mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
        cache: cache as any,
        icmpAdapter: null,
        repository: new MonitoringRepository(),
        clock,
        setTimeout: () => ({ cancel: () => {} }),
      }, CONFIG);

      const result = await engine.runPrtgCycle();
      expect(result.observations).toBe(1);
      expect(cache.forceRefresh).toHaveBeenCalledTimes(1);

      const state = monitoringRepository.findById(c1.id);
      expect(state).not.toBeNull();
      expect(state!.stableHealth).toBe('UNKNOWN');
      expect(state!.consecutiveCount).toBe(1);
    });

    it('same generation skips second cycle', async () => {
      const cache = makeFakeCache(makeSnapshot([
        { objectId: 1001, sensorType: 'Ping', statusRaw: 3 },
      ]));
      const c1 = customerRepository.findByClientId('prtg1');
      if (!c1) throw new Error('not found');
      mappingRepository.create({
        customerId: c1.id, prtgObjectId: 1001, prtgDeviceName: 'D', prtgSensorName: 'Ping',
        mappingMethod: 'manual', confidence: 0.95, verified: true, mappedByTelegramId: 'admin1',
      });

      const engine = new MonitoringEngine({
        customerService: {
          listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
          getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
        },
        mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
        cache: cache as any,
        icmpAdapter: null,
        repository: new MonitoringRepository(),
        clock,
        setTimeout: () => ({ cancel: () => {} }),
      }, CONFIG);

      await engine.runPrtgCycle();
      const result2 = await engine.runPrtgCycle();
      expect(result2.observations).toBe(0);
    });

    it('refresh failure does not cause false DOWN', async () => {
      const c1 = customerRepository.findByClientId('prtg1');
      if (!c1) throw new Error('not found');
      mappingRepository.create({
        customerId: c1.id, prtgObjectId: 1001, prtgDeviceName: 'D', prtgSensorName: 'Ping',
        mappingMethod: 'manual', confidence: 0.95, verified: true, mappedByTelegramId: 'admin1',
      });

      const cache = {
        getFresh: () => null,
        getStale: () => null,
        isFresh: () => false,
        isStale: () => false,
        isExpired: () => true,
        hasAnySnapshot: () => false,
        forceRefresh: vi.fn().mockRejectedValue(new Error('Network error')),
      };

      const engine = new MonitoringEngine({
        customerService: {
          listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
          getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
        },
        mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
        cache: cache as any,
        icmpAdapter: null,
        repository: new MonitoringRepository(),
        clock,
        setTimeout: () => ({ cancel: () => {} }),
      }, CONFIG);

      const result = await engine.runPrtgCycle();
      expect(result.errors).toBe(1);
      expect(result.observations).toBe(0);
    });

    it('two consecutive DOWN samples stabilize to DOWN', async () => {
      const c1 = customerRepository.findByClientId('prtg1');
      if (!c1) throw new Error('not found');
      mappingRepository.create({
        customerId: c1.id, prtgObjectId: 1001, prtgDeviceName: 'D', prtgSensorName: 'Ping',
        mappingMethod: 'manual', confidence: 0.95, verified: true, mappedByTelegramId: 'admin1',
      });

      let gen = 1;
      const cache = {
        getFresh: () => null,
        getStale: () => null,
        isFresh: () => false,
        isStale: () => false,
        isExpired: () => true,
        hasAnySnapshot: () => false,
        forceRefresh: vi.fn().mockImplementation(async () => {
          return {
            sensors: [{ objectId: 1001, deviceName: 'D', sensorName: 'Ping', sensorType: 'Ping', statusRaw: 5, statusDisplay: 'Down', statusMessage: null, lastValue: null, lastUp: null, lastDown: null }],
            devices: [],
            generation: gen++,
            fetchedAt: new Date().toISOString(),
          } as InventorySnapshot;
        }),
      };

      const engine = new MonitoringEngine({
        customerService: {
          listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
          getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
        },
        mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
        cache: cache as any,
        icmpAdapter: null,
        repository: new MonitoringRepository(),
        clock: () => currentTime,
        setTimeout: () => ({ cancel: () => {} }),
      }, CONFIG);

      await engine.runPrtgCycle();
      let state = monitoringRepository.findById(c1.id);
      expect(state!.stableHealth).toBe('UNKNOWN');
      expect(state!.consecutiveCount).toBe(1);

      await engine.runPrtgCycle();
      state = monitoringRepository.findById(c1.id);
      expect(state!.stableHealth).toBe('DOWN');
      expect(state!.consecutiveCount).toBe(2);
      expect(state!.lastTransitionKind).toBe(null);
    });
  });

  describe('ICMP cycle', () => {
    it('disabled customers are skipped', async () => {
      const mockIcmp = new IcmpAdapter({
        runPing: vi.fn().mockResolvedValue({ status: 'UP', reason: 'reply', rtt: 1.5 }),
        clock,
      });

      const engine = new MonitoringEngine({
        customerService: {
          listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'icmp' }),
          getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
        },
        mappingService: { getByCustomerId: () => null },
        cache: null,
        icmpAdapter: mockIcmp,
        repository: new MonitoringRepository(),
        clock,
        setTimeout: () => ({ cancel: () => {} }),
      }, CONFIG);

      const result = await engine.runIcmpCycle();
      expect(result.observations).toBe(1);
      const icmpState = monitoringRepository.findById(
        customerRepository.findByClientId('icmp1')!.id
      );
      expect(icmpState).toBeDefined();
      expect(icmpState!.monitorType).toBe('icmp');
    });

    it('invalid host does not execute ping', async () => {
      const runPing = vi.fn().mockResolvedValue({ status: 'UP', reason: 'reply', rtt: 1.5 });
      const mockIcmp = new IcmpAdapter({ runPing, clock });

      customerRepository.bulkCreate([
        { clientId: 'badhost', name: 'Bad Host', monitorType: 'icmp', pingHost: '; rm -rf /', enabled: true },
      ]);

      const engine = new MonitoringEngine({
        customerService: {
          listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'icmp' }),
          getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
        },
        mappingService: { getByCustomerId: () => null },
        cache: null,
        icmpAdapter: mockIcmp,
        repository: new MonitoringRepository(),
        clock,
        setTimeout: () => ({ cancel: () => {} }),
      }, CONFIG);

      await engine.runIcmpCycle();
      const calls = runPing.mock.calls;
      for (const call of calls) {
        expect(call[0]).not.toBe('; rm -rf /');
      }
    });
  });
});

describe('ICMP adapter security', () => {
  it('exit 0 → UP', async () => {
    const runPing = vi.fn().mockResolvedValue({ status: 'UP', reason: 'reply_received', rtt: 1.5 });
    const adapter = new IcmpAdapter({ runPing, clock: () => Date.now() });
    const result = await adapter.probe('10.0.0.1');
    expect(result.status).toBe('UP');
  });

  it('exit 1 → DOWN', async () => {
    const runPing = vi.fn().mockResolvedValue({ status: 'DOWN', reason: 'no_reply', rtt: null });
    const adapter = new IcmpAdapter({ runPing, clock: () => Date.now() });
    const result = await adapter.probe('10.0.0.1');
    expect(result.status).toBe('DOWN');
  });

  it('exit 2 / ENOENT → UNKNOWN', async () => {
    const runPing = vi.fn().mockResolvedValue({ status: 'UNKNOWN', reason: 'binary_missing', rtt: null });
    const adapter = new IcmpAdapter({ runPing, clock: () => Date.now() });
    const result = await adapter.probe('10.0.0.1');
    expect(result.status).toBe('UNKNOWN');
  });

  it('concurrency limit respected', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const runPing = vi.fn().mockImplementation(async (host: string) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 50));
      concurrent--;
      return { status: 'UP', reason: 'reply', rtt: 1.0 };
    });

    const adapter = new IcmpAdapter({ runPing, clock: () => Date.now() });
    const hosts = Array.from({ length: 10 }, (_, i) => ({ host: `10.0.0.${i + 1}`, generation: 1 }));
    await adapter.probeEligible(hosts, 3, 3000);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });
});

describe('MonitoringEngine - F3: persistence and generation', () => {
  let clock: () => number;
  let currentTime: number;
  let fakeRepo: { upsertBatch: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    vi.stubEnv('MONITORING_ENABLED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
    pendingMappingStore.cleanup();

    customerRepository.bulkCreate([
      { clientId: 'prtg1', name: 'PRTG Customer', monitorType: 'prtg', pingHost: null, enabled: true },
    ]);

    const c1 = customerRepository.findByClientId('prtg1');
    if (!c1) throw new Error('Customer not found');
    mappingRepository.create({
      customerId: c1.id, prtgObjectId: 1001, prtgDeviceName: 'D', prtgSensorName: 'Ping',
      mappingMethod: 'manual', confidence: 0.95, verified: true, mappedByTelegramId: 'admin1',
    });

    currentTime = Date.now();
    clock = () => currentTime;

    fakeRepo = {
      upsertBatch: vi.fn(),
      findById: vi.fn().mockReturnValue(null),
      upsert: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('DB failure does not advance lastPrtgGeneration', async () => {
    let gen = 1;
    const cache = {
      getFresh: () => null,
      getStale: () => null,
      isFresh: () => false,
      isStale: () => false,
      isExpired: () => true,
      hasAnySnapshot: () => false,
      forceRefresh: vi.fn().mockImplementation(async () => {
        return {
          sensors: [{ objectId: 1001, deviceName: 'D', sensorName: 'Ping', sensorType: 'Ping', statusRaw: 3, statusDisplay: 'Up', statusMessage: null, lastValue: null, lastUp: null, lastDown: null }],
          devices: [],
          generation: gen++,
          fetchedAt: new Date().toISOString(),
        } as InventorySnapshot;
      }),
    };

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: fakeRepo as any,
      clock,
      setTimeout: () => ({ cancel: () => {} }),
    }, CONFIG);

    const result1 = await engine.runPrtgCycle();
    expect(result1.observations).toBe(1);
    expect(fakeRepo.upsertBatch).toHaveBeenCalledTimes(1);

    fakeRepo.upsertBatch.mockImplementationOnce(() => { throw new Error('DB failure'); });

    const result2 = await engine.runPrtgCycle();
    expect(result2.errors).toBe(1);

    const result3 = await engine.runPrtgCycle();
    expect(result3.observations).toBe(1);
    expect(result3.errors).toBe(0);
  });

  it('SQLite upsertBatch rolls back on failure (no partial commit)', async () => {
    const c2 = customerRepository.bulkCreate([
      { clientId: 'prtg2', name: 'PRTG Customer 2', monitorType: 'prtg', pingHost: null, enabled: true },
    ])[0];
    mappingRepository.create({
      customerId: c2.id, prtgObjectId: 2002, prtgDeviceName: 'D2', prtgSensorName: 'Ping',
      mappingMethod: 'manual', confidence: 0.95, verified: true, mappedByTelegramId: 'admin1',
    });

    const cache = {
      getFresh: () => null,
      getStale: () => null,
      isFresh: () => false,
      isStale: () => false,
      isExpired: () => true,
      hasAnySnapshot: () => false,
      forceRefresh: vi.fn().mockResolvedValue(makeSnapshot([
        { objectId: 1001, sensorType: 'Ping', statusRaw: 3 },
        { objectId: 2002, sensorType: 'Ping', statusRaw: 5 },
      ])),
    };

    const realRepo = new MonitoringRepository();
    const spy = vi.spyOn(realRepo, 'upsertBatch').mockImplementation(() => {
      throw new Error('Simulated DB failure');
    });

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: realRepo,
      clock,
      setTimeout: () => ({ cancel: () => {} }),
    }, CONFIG);

    const result = await engine.runPrtgCycle();
    expect(result.errors).toBe(1);
    expect(result.observations).toBe(2);

    const state1 = realRepo.findById(c2.id);
    expect(state1).toBeNull();

    spy.mockRestore();
  });
});

describe('MonitoringEngine - F4: target change during probe', () => {
  let clock: () => number;
  let currentTime: number;

  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    vi.stubEnv('MONITORING_ENABLED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
    pendingMappingStore.cleanup();

    customerRepository.bulkCreate([
      { clientId: 'prtg1', name: 'PRTG Customer', monitorType: 'prtg', pingHost: null, enabled: true },
      { clientId: 'icmp1', name: 'ICMP Customer', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true },
    ]);

    const c1 = customerRepository.findByClientId('prtg1');
    if (!c1) throw new Error('not found');
    mappingRepository.create({
      customerId: c1.id, prtgObjectId: 1001, prtgDeviceName: 'D', prtgSensorName: 'Ping',
      mappingMethod: 'manual', confidence: 0.95, verified: true, mappedByTelegramId: 'admin1',
    });

    currentTime = Date.now();
    clock = () => currentTime;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('disabled customer during PRTG cycle is discarded', async () => {
    const cache = {
      getFresh: () => null, getStale: () => null, isFresh: () => false,
      isStale: () => false, isExpired: () => true, hasAnySnapshot: () => false,
      forceRefresh: vi.fn().mockImplementation(async () => {
        customerRepository.update(c1.id, { enabled: false });
        return makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
      }),
    };
    const c1 = customerRepository.findByClientId('prtg1');
    if (!c1) throw new Error('not found');

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: new MonitoringRepository(),
      clock,
      setTimeout: () => ({ cancel: () => {} }),
    }, CONFIG);

    const result = await engine.runPrtgCycle();
    expect(result.observations).toBe(0);
    const state = monitoringRepository.findById(c1.id);
    expect(state).toBeNull();
  });

  it('host change during ICMP probe is discarded', async () => {
    const c1 = customerRepository.findByClientId('icmp1');
    if (!c1) throw new Error('not found');

    let changedHost = false;
    const runPing = vi.fn().mockImplementation(async (host: string) => {
      changedHost = true;
      customerRepository.update(c1.id, { pingHost: '10.0.0.999' });
      return { status: 'UP', reason: 'reply', rtt: 1.0 };
    });

    const mockIcmp = new IcmpAdapter({ runPing, clock });

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'icmp' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: () => null },
      cache: null,
      icmpAdapter: mockIcmp,
      repository: new MonitoringRepository(),
      clock,
      setTimeout: () => ({ cancel: () => {} }),
    }, CONFIG);

    const result = await engine.runIcmpCycle();
    expect(result.observations).toBe(0);
  });
});

describe('MonitoringEngine - F5: stop, abort, no late writes', () => {
  let clock: () => number;
  let currentTime: number;

  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    vi.stubEnv('MONITORING_ENABLED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
    pendingMappingStore.cleanup();

    customerRepository.bulkCreate([
      { clientId: 'prtg1', name: 'PRTG Customer', monitorType: 'prtg', pingHost: null, enabled: true },
    ]);

    const c1 = customerRepository.findByClientId('prtg1');
    if (!c1) throw new Error('not found');
    mappingRepository.create({
      customerId: c1.id, prtgObjectId: 1001, prtgDeviceName: 'D', prtgSensorName: 'Ping',
      mappingMethod: 'manual', confidence: 0.95, verified: true, mappedByTelegramId: 'admin1',
    });

    currentTime = Date.now();
    clock = () => currentTime;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stop prevents late writes after cycle already running', async () => {
    let resolveRefresh: (value: any) => void = () => {};
    const refreshPromise = new Promise((resolve) => { resolveRefresh = resolve; });
    let refreshCalled = false;

    const cache = {
      getFresh: () => null, getStale: () => null, isFresh: () => false,
      isStale: () => false, isExpired: () => true, hasAnySnapshot: () => false,
      forceRefresh: vi.fn().mockImplementation(async () => {
        refreshCalled = true;
        return refreshPromise;
      }),
    };

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: new MonitoringRepository(),
      clock,
      setTimeout: () => ({ cancel: () => {} }),
    }, CONFIG);

    const cyclePromise = engine.runPrtgCycle();
    while (!refreshCalled) await new Promise(r => setTimeout(r, 10));

    engine.stop();
    const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 3 }]);
    resolveRefresh(snap);
    await cyclePromise;

    const c1 = customerRepository.findByClientId('prtg1');
    if (!c1) throw new Error('not found');
    const state = monitoringRepository.findById(c1.id);
    expect(state).toBeNull();
  });

  it('concurrent runOncePrtg does not overlap', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const cache = {
      getFresh: () => null, getStale: () => null, isFresh: () => false,
      isStale: () => false, isExpired: () => true, hasAnySnapshot: () => false,
      forceRefresh: vi.fn().mockImplementation(async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise(r => setTimeout(r, 50));
        inFlight--;
        return makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 3 }]);
      }),
    };

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: new MonitoringRepository(),
      clock,
      setTimeout: () => ({ cancel: () => {} }),
    }, CONFIG);

    await Promise.all([engine.runOncePrtg(), engine.runOncePrtg()]);
    expect(maxConcurrent).toBe(1);
  });

  it('exception in cycle does not cause unhandled rejection', async () => {
    const cache = {
      getFresh: () => null, getStale: () => null, isFresh: () => false,
      isStale: () => false, isExpired: () => true, hasAnySnapshot: () => false,
      forceRefresh: vi.fn().mockRejectedValue(new Error('Network error')),
    };

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: new MonitoringRepository(),
      clock,
      setTimeout: () => ({ cancel: () => {} }),
    }, CONFIG);

    const result = await engine.runPrtgCycle();
    expect(result.errors).toBe(1);
  });
});

describe('MonitoringEngine - F6: ICMP timeout config wiring', () => {
  it('probeEligible passes config timeoutMs to runPing', async () => {
    const runPing = vi.fn().mockResolvedValue({ status: 'UP', reason: 'reply', rtt: 1.5 });
    const adapter = new IcmpAdapter({ runPing, clock: Date.now });

    await adapter.probeEligible(
      [{ host: '10.0.0.1', generation: 1 }],
      5,
      9000,
    );

    expect(runPing).toHaveBeenCalledWith('10.0.0.1', 9000, expect.anything());
  });

  it('probe passes config timeoutMs to runPing', async () => {
    const runPing = vi.fn().mockResolvedValue({ status: 'UP', reason: 'reply', rtt: 1.5 });
    const adapter = new IcmpAdapter({ runPing, clock: Date.now });

    await adapter.probe('10.0.0.1', 15000);

    expect(runPing).toHaveBeenCalledWith('10.0.0.1', 15000, undefined);
  });
});

describe('MonitoringEngine - F5: scheduler lifecycle', () => {
  let clock: () => number;
  let currentTime: number;

  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    vi.stubEnv('MONITORING_ENABLED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
    pendingMappingStore.cleanup();

    customerRepository.bulkCreate([
      { clientId: 'prtg1', name: 'PRTG Customer', monitorType: 'prtg', pingHost: null, enabled: true },
    ]);
    const c1 = customerRepository.findByClientId('prtg1');
    if (!c1) throw new Error('not found');
    mappingRepository.create({
      customerId: c1.id, prtgObjectId: 1001, prtgDeviceName: 'D', prtgSensorName: 'Ping',
      mappingMethod: 'manual', confidence: 0.95, verified: true, mappedByTelegramId: 'admin1',
    });

    currentTime = Date.now();
    clock = () => currentTime;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('three cycles scheduled via fake timers complete sequentially', async () => {
    let cycleCount = 0;
    const timers: Array<() => void> = [];
    let cancelCount = 0;
    const setTimeoutMock = (cb: () => void, ms: number) => {
      void ms;
      timers.push(cb);
      return { cancel: () => { cancelCount++; } };
    };

    const cache = {
      getFresh: () => null, getStale: () => null, isFresh: () => false,
      isStale: () => false, isExpired: () => true, hasAnySnapshot: () => false,
      forceRefresh: vi.fn().mockImplementation(async () => {
        cycleCount++;
        const gen = cycleCount;
        return {
          sensors: [{ objectId: 1001, deviceName: 'D', sensorName: 'Ping', sensorType: 'Ping', statusRaw: 3, statusDisplay: 'Up', statusMessage: null, lastValue: null, lastUp: null, lastDown: null }],
          devices: [],
          generation: gen,
          fetchedAt: new Date().toISOString(),
        } as InventorySnapshot;
      }),
    };

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: new MonitoringRepository(),
      clock,
      setTimeout: setTimeoutMock,
    }, CONFIG);

    engine.start();
    expect(cycleCount).toBe(0);

    timers.shift()!();
    await flushMicrotasks();
    expect(cycleCount).toBe(1);

    timers.shift()!();
    await flushMicrotasks();
    timers.shift()!();
    await flushMicrotasks();
    expect(cycleCount).toBe(2);

    timers.shift()!();
    await flushMicrotasks();
    timers.shift()!();
    await flushMicrotasks();
    expect(cycleCount).toBe(3);

    await engine.stop();
  });

  it('cycle failure does not break reschedule', async () => {
    let callCount = 0;
    const timers: Array<() => void> = [];
    const cache = {
      getFresh: () => null, getStale: () => null, isFresh: () => false,
      isStale: () => false, isExpired: () => true, hasAnySnapshot: () => false,
      forceRefresh: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('network failure');
        return {
          sensors: [{ objectId: 1001, deviceName: 'D', sensorName: 'Ping', sensorType: 'Ping', statusRaw: 3, statusDisplay: 'Up', statusMessage: null, lastValue: null, lastUp: null, lastDown: null }],
          devices: [],
          generation: 2,
          fetchedAt: new Date().toISOString(),
        } as InventorySnapshot;
      }),
    };

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: new MonitoringRepository(),
      clock,
      setTimeout: (cb: () => void) => { timers.push(cb); return { cancel: () => {} }; },
    }, CONFIG);

    engine.start();
    timers.shift()!();
    await flushMicrotasks();
    expect(callCount).toBe(1);

    timers.shift()!();
    await flushMicrotasks();
    timers.shift()!();
    await flushMicrotasks();
    expect(callCount).toBe(2);

    await engine.stop();
  });

  it('startup listAll failure does not cause unhandled rejection', async () => {
    let rejected = false;
    process.on('unhandledRejection', () => { rejected = true; });

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => { throw new Error('DB unavailable'); },
        getByClientId: () => null,
      },
      mappingService: { getByCustomerId: () => null },
      cache: { forceRefresh: vi.fn() } as any,
      icmpAdapter: null,
      repository: new MonitoringRepository(),
      clock,
      setTimeout: (cb: () => void) => { cb(); return { cancel: () => {} }; },
    }, CONFIG);

    engine.start();
    await engine.stop();
    expect(rejected).toBe(false);
  });
});

describe('MonitoringEngine - F2: stable observation identity', () => {
  let clock: () => number;
  let currentTime: number;

  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    vi.stubEnv('MONITORING_ENABLED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
    pendingMappingStore.cleanup();

    customerRepository.bulkCreate([
      { clientId: 'prtg1', name: 'PRTG Customer', monitorType: 'prtg', pingHost: null, enabled: true },
    ]);
    const c1 = customerRepository.findByClientId('prtg1');
    if (!c1) throw new Error('not found');
    mappingRepository.create({
      customerId: c1.id, prtgObjectId: 1001, prtgDeviceName: 'D', prtgSensorName: 'Ping',
      mappingMethod: 'manual', confidence: 0.95, verified: true, mappedByTelegramId: 'admin1',
    });

    currentTime = Date.now();
    clock = () => currentTime;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('same snapshot processed at different clock times produces same observationId', async () => {
    const fetchedAt = new Date().toISOString();
    let clockTime = 1000;
    const snap: InventorySnapshot = {
      sensors: [{ objectId: 1001, deviceName: 'D', sensorName: 'Ping', sensorType: 'Ping', statusRaw: 3, statusDisplay: 'Up', statusMessage: null, lastValue: null, lastUp: null, lastDown: null }],
      devices: [],
      generation: 1,
      fetchedAt,
    } as InventorySnapshot;

    const cache = {
      getFresh: () => null, getStale: () => null, isFresh: () => false,
      isStale: () => false, isExpired: () => true, hasAnySnapshot: () => false,
      forceRefresh: vi.fn().mockResolvedValue(snap),
    };

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: new MonitoringRepository(),
      clock: () => clockTime,
      setTimeout: () => ({ cancel: () => {} }),
    }, CONFIG);

    clockTime = 1000;
    await engine.runPrtgCycle();
    const state1 = monitoringRepository.findById(1);
    expect(state1?.lastProcessedObservationId).toBe(`prtg|1|${fetchedAt}|1001`);

    clockTime = 50000;
    await engine.runPrtgCycle();
    const state2 = monitoringRepository.findById(1);
    expect(state2?.lastProcessedObservationId).toBe(state1?.lastProcessedObservationId);
  });

  it('new snapshot (different fetchedAt) produces different observationId', async () => {
    const snap1: InventorySnapshot = {
      sensors: [{ objectId: 1001, deviceName: 'D', sensorName: 'Ping', sensorType: 'Ping', statusRaw: 3, statusDisplay: 'Up', statusMessage: null, lastValue: null, lastUp: null, lastDown: null }],
      devices: [],
      generation: 1,
      fetchedAt: new Date(1000).toISOString(),
    } as InventorySnapshot;

    const snap2: InventorySnapshot = {
      sensors: [{ objectId: 1001, deviceName: 'D', sensorName: 'Ping', sensorType: 'Ping', statusRaw: 3, statusDisplay: 'Up', statusMessage: null, lastValue: null, lastUp: null, lastDown: null }],
      devices: [],
      generation: 2,
      fetchedAt: new Date(2000).toISOString(),
    } as InventorySnapshot;

    let callCount = 0;
    const cache = {
      getFresh: () => null, getStale: () => null, isFresh: () => false,
      isStale: () => false, isExpired: () => true, hasAnySnapshot: () => false,
      forceRefresh: vi.fn().mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? snap1 : snap2;
      }),
    };

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: new MonitoringRepository(),
      clock: () => 1000,
      setTimeout: () => ({ cancel: () => {} }),
    }, CONFIG);

    await engine.runPrtgCycle();
    const state1 = monitoringRepository.findById(1);

    await engine.runPrtgCycle();
    const state2 = monitoringRepository.findById(1);

    expect(state1?.lastObservationAt).not.toBe(state2?.lastObservationAt);
  });
});

describe('MonitoringEngine - lifecycle (F5)', () => {
  it('engine runs full PRTG cycle and persists state', async () => {
    const timers: Array<() => void> = [];
    const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 3 }]);
    const cache = makeFakeCache(snap, null);
    const clock = () => 1000;

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: new MonitoringRepository(),
      clock,
      setTimeout: (cb: () => void) => { timers.push(cb); return { cancel: () => {} }; },
    }, CONFIG);

    engine.start();

    // Run first cycle
    timers.shift()!();
    await flushMicrotasks();

    const c1 = customerRepository.findByClientId('prtg1');
    expect(c1).toBeTruthy();
    const state = monitoringRepository.findById(c1!.id);
    expect(state).toBeTruthy();
    expect(state!.latestObservation).toBe('UP');
    expect(state!.consecutiveCount).toBe(1);

    await engine.stop();
  });

  it('engine runOncePrtg executes cycle without scheduler', async () => {
    const snap = makeSnapshot([{ objectId: 1001, sensorType: 'Ping', statusRaw: 5 }]);
    const cache = makeFakeCache(snap, null);
    const clock = () => 1000;

    const engine = new MonitoringEngine({
      customerService: {
        listAll: () => customerRepository.findAllUnpaged({ enabled: true, monitorType: 'prtg' }),
        getByClientId: (clientId: string) => customerRepository.findByClientId(clientId),
      },
      mappingService: { getByCustomerId: (id: number) => mappingRepository.findByCustomerId(id) },
      cache: cache as any,
      icmpAdapter: null,
      repository: new MonitoringRepository(),
      clock,
      setTimeout: (cb: () => void) => { return { cancel: () => {} }; },
    }, CONFIG);

    const result = await engine.runOncePrtg();
    expect(result.cycle).toBe('prtg');
    expect(result.observations).toBe(1);
    expect(result.errors).toBe(0);

    const c1 = customerRepository.findByClientId('prtg1');
    const state = monitoringRepository.findById(c1!.id);
    expect(state).toBeTruthy();
    expect(state!.latestObservation).toBe('DOWN');
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}
