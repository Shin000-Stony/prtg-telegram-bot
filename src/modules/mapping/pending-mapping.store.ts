import { getLogger } from '../../core/logger';
import { randomUUID } from 'crypto';

const logger = getLogger().child({ module: 'PendingMappingStore' });

export type PendingActionType = 'map' | 'auto_map' | 'unmap' | 'search';

export interface PendingMap {
  id: string;
  action: 'map';
  chatId: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  inventoryGeneration: number;
  customerId: number;
  prtgObjectId: number;
  expectedCustomer: { id: number; clientId: string; name: string; enabled: boolean; monitorType: string };
  expectedSensor: { objectId: number; deviceName: string; sensorName: string; sensorType: string };
}

export interface PendingAutoMap {
  id: string;
  action: 'auto_map';
  chatId: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  inventoryGeneration: number;
  decisions: Array<{
    customerId: number;
    objectId: number;
    confidence: number;
    reason: string;
    customerFingerprint: { clientId: string; name: string; enabled: boolean; monitorType: string };
  }>;
}

export interface PendingUnmap {
  id: string;
  action: 'unmap';
  chatId: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  inventoryGeneration: number;
  customerId: number;
  mappingId: number;
  expectedMapping: { customerId: number; prtgObjectId: number; mappingMethod: string; verified: boolean };
}

export interface PendingSearch {
  id: string;
  action: 'search';
  chatId: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  inventoryGeneration: number;
  customerId: number;
  page: number;
  candidates: Array<{ objectId: number; deviceName: string; sensorName: string; sensorType: string }>;
}

export type PendingMapping = PendingMap | PendingAutoMap | PendingUnmap | PendingSearch;

const TTL_MS = 5 * 60_000;
const MAX_PENDING = 100;

export class PendingMappingStore {
  private store = new Map<string, PendingMapping>();

  private createPending<T extends PendingMapping>(action: PendingActionType, data: Omit<T, 'id' | 'createdAt' | 'expiresAt' | 'action'>): T {
    if (this.store.size >= MAX_PENDING) {
      this.cleanup();
      if (this.store.size >= MAX_PENDING) {
        throw new Error('Pending mapping store is full; please retry later');
      }
    }

    const id = randomUUID();
    const now = new Date();
    const pending: T = {
      ...data,
      id,
      action,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    } as T;
    this.store.set(id, pending);
    logger.info({ id, action, chatId: data.chatId, userId: data.userId }, 'Created pending mapping');
    return pending;
  }

  createMap(data: Omit<PendingMap, 'id' | 'createdAt' | 'expiresAt' | 'action'>): PendingMap {
    return this.createPending('map', data);
  }

  createAutoMap(data: Omit<PendingAutoMap, 'id' | 'createdAt' | 'expiresAt' | 'action'>): PendingAutoMap {
    return this.createPending('auto_map', data);
  }

  createUnmap(data: Omit<PendingUnmap, 'id' | 'createdAt' | 'expiresAt' | 'action'>): PendingUnmap {
    return this.createPending('unmap', data);
  }

  createSearch(data: Omit<PendingSearch, 'id' | 'createdAt' | 'expiresAt' | 'action'>): PendingSearch {
    return this.createPending('search', data);
  }

  get(id: string): PendingMapping | undefined {
    const pending = this.store.get(id);
    if (!pending) {
      return undefined;
    }
    if (pending.expiresAt < new Date()) {
      this.store.delete(id);
      logger.info({ id }, 'Pending mapping expired');
      return undefined;
    }
    return pending;
  }

  consume(id: string): PendingMapping | undefined {
    const pending = this.get(id);
    if (pending) {
      this.store.delete(id);
      logger.info({ id }, 'Consumed pending mapping');
    }
    return pending;
  }

  delete(id: string): boolean {
    const existed = this.store.has(id);
    if (existed) {
      this.store.delete(id);
      logger.info({ id }, 'Deleted pending mapping');
    }
    return existed;
  }

  cleanup(): number {
    const now = new Date();
    let count = 0;
    for (const [id, pending] of this.store.entries()) {
      if (pending.expiresAt < now) {
        this.store.delete(id);
        count++;
      }
    }
    if (count > 0) {
      logger.info({ count }, 'Cleaned up expired pending mappings');
    }
    return count;
  }

  size(): number {
    this.cleanup();
    return this.store.size;
  }
}

export const pendingMappingStore = new PendingMappingStore();