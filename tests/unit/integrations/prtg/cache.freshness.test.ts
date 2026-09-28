import { describe, it, expect, beforeEach } from 'vitest';
import { PrtgInventoryCache } from '@/integrations/prtg/prtg.inventory.cache';
import { PrtgClient } from '@/integrations/prtg/prtg.client';
import type { PrtgSensor, PrtgDevice } from '@/integrations/prtg/prtg.types';

class FakeClient {
  public callCount = 0;
  public shouldThrow = false;
  public result: { sensors: PrtgSensor[]; devices: PrtgDevice[] } = { sensors: [], devices: [] };

  async fetchInventory() {
    this.callCount++;
    if (this.shouldThrow) {
      throw new Error('fetch failed');
    }
    return this.result;
  }
}

function makeSensor(over: Partial<PrtgSensor> = {}): PrtgSensor {
  return {
    objectId: 1,
    deviceName: 'D1',
    sensorName: 'S1',
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

describe('R6: Cache freshness and completeness', () => {
  const now = 1_700_000_000_000;
  let currentTime = now;

  function createTimeClient(result: { sensors: PrtgSensor[]; devices: PrtgDevice[] } = { sensors: [], devices: [] }) {
    const client = new FakeClient();
    client.result = result;
    return client;
  }

  function makeCache(client: FakeClient) {
    const clock = () => currentTime;
    return new PrtgInventoryCache(client as unknown as PrtgClient, clock);
  }

  beforeEach(() => {
    currentTime = now;
  });

  describe('empty cache behavior', () => {
    it('getFresh returns null on empty cache', () => {
      const cache = makeCache(createTimeClient());
      expect(cache.getFresh()).toBeNull();
    });

    it('isFresh returns false on empty cache', () => {
      const cache = makeCache(createTimeClient());
      expect(cache.isFresh()).toBe(false);
    });
  });

  describe('stale snapshot cannot be used for mutations', () => {
    it('getFresh returns null for stale snapshot', async () => {
      const client = createTimeClient({ sensors: [makeSensor()], devices: [] });
      const cache = makeCache(client);

      await cache.refresh();

      // Advance past TTL (5 min)
      currentTime = now + 6 * 60_000;

      expect(cache.isFresh()).toBe(false);
      expect(cache.isStale()).toBe(true);
      expect(cache.getFresh()).toBeNull();
      expect(cache.getStale()).not.toBeNull();
    });

    it('expired snapshot is not stale', async () => {
      const client = createTimeClient({ sensors: [makeSensor()], devices: [] });
      const cache = makeCache(client);

      await cache.refresh();

      // Advance past max stale age (30 min)
      currentTime = now + 31 * 60_000;

      expect(cache.isExpired()).toBe(true);
      expect(cache.isStale()).toBe(false);
      expect(cache.getStale()).toBeNull();
    });
  });

  describe('force refresh triggers new fetch', () => {
    it('forceRefresh bypasses TTL check', async () => {
      const client = createTimeClient({ sensors: [makeSensor()], devices: [] });
      const cache = makeCache(client);

      await cache.refresh();
      expect(client.callCount).toBe(1);

      // Even within TTL, forceRefresh should fetch
      await cache.forceRefresh();
      expect(client.callCount).toBe(2);
    });
  });

  describe('coalesced refresh', () => {
    it('concurrent refreshes produce single fetch', async () => {
      const client = createTimeClient({ sensors: [makeSensor()], devices: [] });
      const cache = makeCache(client);

      const [r1, r2, r3] = await Promise.all([
        cache.refresh(),
        cache.refresh(),
        cache.refresh(),
      ]);

      expect(client.callCount).toBe(1);
      expect(r1).toBe(r2);
      expect(r2).toBe(r3);
    });
  });

  describe('failed refresh keeps stale snapshot', () => {
    it('failed refresh does not overwrite existing snapshot', async () => {
      const client = createTimeClient({ sensors: [makeSensor({ objectId: 1 })], devices: [] });
      const cache = makeCache(client);

      await cache.refresh();
      const snap1 = cache.getFresh();
      expect(snap1).not.toBeNull();

      // Advance past TTL
      currentTime = now + 6 * 60_000;

      // Now make fetch fail
      client.shouldThrow = true;
      await expect(cache.refresh()).rejects.toThrow('fetch failed');

      // Snapshot should still exist (stale)
      const snap2 = cache.getStale();
      expect(snap2).toBe(snap1);
      expect(snap2?.sensors).toHaveLength(1);
    });
  });

  describe('restart behavior', () => {
    it('cache starts empty after construction', () => {
      const cache = makeCache(createTimeClient());
      expect(cache.hasAnySnapshot()).toBe(false);
      expect(cache.isFresh()).toBe(false);
      expect(cache.isStale()).toBe(false);
    });
  });
});
