import { describe, it, expect, beforeEach } from 'vitest';
import { PrtgInventoryCache, createPrtgInventoryCache } from '@/integrations/prtg/prtg.inventory.cache';
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

function makeCache(client: FakeClient, clock?: () => number) {
  return new PrtgInventoryCache(client as unknown as PrtgClient, clock);
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

function makeDevice(over: Partial<PrtgDevice> = {}): PrtgDevice {
  return {
    objectId: 10,
    deviceName: 'Dev1',
    host: '10.0.0.1',
    statusRaw: 3,
    statusDisplay: 'Up',
    ...over,
  };
}

describe('PrtgInventoryCache', () => {
  const now = 1_700_000_000_000;
  let clock: () => number;

  beforeEach(() => {
    clock = () => now;
  });

  describe('empty cache', () => {
    it('hasAnySnapshot returns false when empty', () => {
      const cache = makeCache(new FakeClient(), clock);
      expect(cache.hasAnySnapshot()).toBe(false);
    });

    it('isFresh returns false when empty', () => {
      const cache = makeCache(new FakeClient(), clock);
      expect(cache.isFresh()).toBe(false);
    });

    it('getFresh returns null when empty', () => {
      const cache = makeCache(new FakeClient(), clock);
      expect(cache.getFresh()).toBeNull();
    });
  });

  describe('refresh', () => {
    it('fetches from client and stores snapshot with generation 1', async () => {
      const client = new FakeClient();
      client.result = {
        sensors: [makeSensor({ objectId: 1, deviceName: 'D1', sensorName: 'S1' })],
        devices: [makeDevice({ objectId: 10, deviceName: 'Dev1' })],
      };
      const cache = makeCache(client, clock);

      const snap = await cache.refresh();

      expect(client.callCount).toBe(1);
      expect(snap.generation).toBe(1);
      expect(snap.fetchedAt).toBe(new Date(now).toISOString());
      expect(snap.sensors).toHaveLength(1);
      expect(snap.devices).toHaveLength(1);
    });

    it('isFresh returns true after refresh within TTL', async () => {
      const client = new FakeClient();
      const cache = makeCache(client, clock);

      await cache.refresh();
      expect(cache.isFresh()).toBe(true);
    });

    it('isFresh returns false after TTL expires', async () => {
      let currentTime = now;
      const mutableClock = () => currentTime;
      const client = new FakeClient();
      const cache = makeCache(client, mutableClock);

      await cache.refresh();
      currentTime = now + 6 * 60_000; // 6 minutes later
      expect(cache.isFresh()).toBe(false);
    });
  });

  describe('coalesced refresh', () => {
    it('coalesces concurrent refresh calls into single fetch', async () => {
      const client = new FakeClient();
      const cache = makeCache(client, clock);

      const [r1, r2, r3] = await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);

      expect(client.callCount).toBe(1);
      expect(r1).toBe(r2);
      expect(r2).toBe(r3);
    });

    it('returns cached snapshot when within TTL without fetching', async () => {
      const client = new FakeClient();
      const cache = makeCache(client, clock);

      await cache.refresh();
      expect(client.callCount).toBe(1);

      await cache.refresh();
      expect(client.callCount).toBe(1);
    });
  });

  describe('stale snapshot', () => {
    it('keeps last successful snapshot on failed refresh', async () => {
      let currentTime = now;
      const clock = () => currentTime;
      const client = new FakeClient();
      client.result = { sensors: [makeSensor({ objectId: 1 })], devices: [] };
      const cache = makeCache(client, clock);

      await cache.refresh();
      const snap1 = cache.getFresh();
      expect(snap1?.sensors).toHaveLength(1);

      // Advance time past TTL so refresh will actually fetch
      currentTime = now + 6 * 60_000;
      client.shouldThrow = true;
      await expect(cache.refresh()).rejects.toThrow('fetch failed');

      // Should still have stale snapshot
      expect(cache.getStale()).not.toBeNull();
      expect(cache.getStale()?.sensors).toHaveLength(1);
      expect(cache.getFresh()).toBeNull();
    });

    it('stale snapshot is available but not fresh', async () => {
      let currentTime = now;
      const clock = () => currentTime;
      const client = new FakeClient();
      client.result = { sensors: [makeSensor({ objectId: 1 })], devices: [] };
      const cache = makeCache(client, clock);

      await cache.refresh();
      currentTime = now + 6 * 60_000;
      expect(cache.isFresh()).toBe(false);
      expect(cache.getStale()?.sensors).toHaveLength(1);
    });

    it('stale snapshot is not expired under 30 minutes', async () => {
      let currentTime = now;
      const clock = () => currentTime;
      const client = new FakeClient();
      client.result = { sensors: [makeSensor({ objectId: 1 })], devices: [] };
      const cache = makeCache(client, clock);

      await cache.refresh();
      currentTime = now + 6 * 60_000;
      expect(cache.isStale()).toBe(true);
      expect(cache.isExpired()).toBe(false);
    });

    it('expired snapshot after 30 minutes', async () => {
      let currentTime = now;
      const clock = () => currentTime;
      const client = new FakeClient();
      client.result = { sensors: [makeSensor({ objectId: 1 })], devices: [] };
      const cache = makeCache(client, clock);

      await cache.refresh();
      currentTime = now + 31 * 60_000;
      expect(cache.isExpired()).toBe(true);
      expect(cache.getStale()).toBeNull();
    });
  });

  describe('invalidate', () => {
    it('clears snapshot', async () => {
      const client = new FakeClient();
      const cache = makeCache(client, clock);

      await cache.refresh();
      expect(cache.hasAnySnapshot()).toBe(true);

      cache.invalidate();
      expect(cache.hasAnySnapshot()).toBe(false);
      expect(cache.isFresh()).toBe(false);
    });
  });

  describe('forceRefresh', () => {
    it('forces a new fetch even when cache is fresh', async () => {
      const client = new FakeClient();
      const cache = makeCache(client, clock);

      await cache.refresh();
      expect(client.callCount).toBe(1);

      await cache.forceRefresh();
      expect(client.callCount).toBe(2);
      const snap = cache.getFresh();
      expect(snap?.generation).toBe(2);
    });
  });
});
