import type { PrtgClient } from './prtg.client';
import type { PrtgSensor, PrtgDevice } from './prtg.types';
import { getLogger } from '../../core/logger';

export interface InventorySnapshot {
  sensors: PrtgSensor[];
  devices: PrtgDevice[];
  generation: number;
  fetchedAt: string;
}

const TTL_MS = 5 * 60_000;
const MAX_STALE_AGE_MS = 30 * 60_000;
const REFRESH_DEADLINE_MS = 120_000;

export class PrtgInventoryCache {
  private snapshot: InventorySnapshot | null = null;
  private readonly client: PrtgClient;
  private readonly clock: () => number;
  private readonly logger = getLogger().child({ module: 'PrtgInventoryCache' });

  constructor(client: PrtgClient, clock: () => number = Date.now) {
    this.client = client;
    this.clock = clock;
  }

  isFresh(): boolean {
    if (!this.snapshot) {
      return false;
    }
    const fetchedAtMs = new Date(this.snapshot.fetchedAt).getTime();
    return this.clock() - fetchedAtMs <= TTL_MS;
  }

  isStale(): boolean {
    if (!this.snapshot) {
      return false;
    }
    const fetchedAtMs = new Date(this.snapshot.fetchedAt).getTime();
    const age = this.clock() - fetchedAtMs;
    return age > TTL_MS && age <= MAX_STALE_AGE_MS;
  }

  isExpired(): boolean {
    if (!this.snapshot) {
      return true;
    }
    const fetchedAtMs = new Date(this.snapshot.fetchedAt).getTime();
    return this.clock() - fetchedAtMs > MAX_STALE_AGE_MS;
  }

  getFresh(): InventorySnapshot | null {
    return this.isFresh() ? this.snapshot : null;
  }

  getStale(): InventorySnapshot | null {
    return this.isStale() ? this.snapshot : null;
  }

  hasAnySnapshot(): boolean {
    return this.snapshot !== null;
  }

  async refresh(force = false): Promise<InventorySnapshot> {
    if (!force && this.snapshot) {
      const age = this.clock() - new Date(this.snapshot.fetchedAt).getTime();
      if (age <= TTL_MS) {
        return this.snapshot;
      }
    }

    const inFlight = this.inFlight;
    if (inFlight) {
      this.logger.info({ detail: 'refresh_dedup', skippedNew: true }, 'PRTG refresh in-flight, returning existing promise');
      return inFlight;
    }

    const controller = new AbortController();
    const refreshStart = this.clock();
    this.logger.info({ detail: 'refresh_start', deadlineMs: REFRESH_DEADLINE_MS }, 'PRTG refresh started');

    const deadlineTimer = setTimeout(() => {
      this.logger.warn({ detail: 'refresh_deadline_exceeded', elapsedMs: this.clock() - refreshStart, deadlineMs: REFRESH_DEADLINE_MS }, 'PRTG refresh deadline exceeded, aborting');
      controller.abort();
    }, REFRESH_DEADLINE_MS);

    const promise = this.doRefresh(controller.signal)
      .then((snap) => {
        const elapsed = this.clock() - refreshStart;
        this.logger.info({ detail: 'refresh_success', elapsedMs: elapsed, sensorCount: snap.sensors.length, deviceCount: snap.devices.length }, 'PRTG refresh completed');
        return snap;
      })
      .catch((error) => {
        const elapsed = this.clock() - refreshStart;
        clearTimeout(deadlineTimer);
        this.inFlight = null;
        this.logger.warn({ detail: 'refresh_failed', elapsedMs: elapsed, err: error instanceof Error ? error.message : String(error) }, 'PRTG refresh failed');
        throw error;
      })
      .finally(() => {
        clearTimeout(deadlineTimer);
        if (!this.inFlight || this.inFlight === promise) {
          this.inFlight = null;
        }
      });

    this.inFlight = promise;
    return promise;
  }

  private inFlight: Promise<InventorySnapshot> | null = null;

  private async doRefresh(signal: AbortSignal): Promise<InventorySnapshot> {
    const { sensors, devices } = await this.client.fetchInventory(signal);
    const generation = (this.snapshot?.generation ?? 0) + 1;
    const fetchedAt = new Date(this.clock()).toISOString();

    this.snapshot = { sensors, devices, generation, fetchedAt };
    this.logger.info({ generation, sensorCount: sensors.length, deviceCount: devices.length }, 'Inventory cache refreshed');
    return this.snapshot;
  }

  async forceRefresh(): Promise<InventorySnapshot> {
    return this.refresh(true);
  }

  invalidate(): void {
    this.snapshot = null;
    this.inFlight = null;
  }
}

export function createPrtgInventoryCache(client: PrtgClient, clock?: () => number): PrtgInventoryCache {
  return new PrtgInventoryCache(client, clock);
}