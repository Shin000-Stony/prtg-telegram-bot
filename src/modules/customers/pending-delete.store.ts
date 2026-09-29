import { getLogger } from '../../core/logger';
import { randomUUID } from 'crypto';

const logger = getLogger().child({ module: 'PendingDeleteStore' });

const TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 200;

export interface PendingDelete {
  id: string;
  customerId: number;
  clientId: string;
  name: string;
  chatId: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

export class PendingDeleteStore {
  private store = new Map<string, PendingDelete>();

  create(data: Omit<PendingDelete, 'id' | 'createdAt' | 'expiresAt'>): PendingDelete {
    if (this.store.size >= MAX_SESSIONS) {
      this.cleanup();
      if (this.store.size >= MAX_SESSIONS) {
        throw new Error('Pending delete store is full');
      }
    }

    const now = new Date();
    const session: PendingDelete = {
      ...data,
      id: randomUUID(),
      createdAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    };
    this.store.set(session.id, session);
    logger.info({ id: session.id, customerId: data.customerId }, 'Created pending delete session');
    return session;
  }

  get(id: string): PendingDelete | undefined {
    const session = this.store.get(id);
    if (!session) {
      return undefined;
    }
    if (session.expiresAt < new Date()) {
      this.store.delete(id);
      logger.info({ id }, 'Pending delete session expired');
      return undefined;
    }
    return session;
  }

  consume(id: string): PendingDelete | undefined {
    const session = this.get(id);
    if (session) {
      this.store.delete(id);
      logger.info({ id }, 'Consumed pending delete session');
    }
    return session;
  }

  delete(id: string): boolean {
    const existed = this.store.has(id);
    if (existed) {
      this.store.delete(id);
      logger.info({ id }, 'Deleted pending delete session');
    }
    return existed;
  }

  cleanup(): number {
    const now = new Date();
    let count = 0;
    for (const [id, session] of this.store.entries()) {
      if (session.expiresAt < now) {
        this.store.delete(id);
        count++;
      }
    }
    if (count > 0) {
      logger.info({ count }, 'Cleaned up expired pending delete sessions');
    }
    return count;
  }

  clear(): void {
    const size = this.store.size;
    this.store.clear();
    if (size > 0) {
      logger.info({ size }, 'Cleared all pending delete sessions');
    }
  }
}

export const pendingDeleteStore = new PendingDeleteStore();
