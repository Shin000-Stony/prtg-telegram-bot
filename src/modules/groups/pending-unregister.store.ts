import { getLogger } from '../../core/logger';
import { randomUUID } from 'crypto';

const logger = getLogger().child({ module: 'PendingUnregisterStore' });

export interface PendingUnregister {
  id: string;
  chatId: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

export class PendingUnregisterStore {
  private store = new Map<string, PendingUnregister>();

  create(chatId: string, userId: string): PendingUnregister {
    const id = randomUUID();
    const now = new Date();
    const pending: PendingUnregister = {
      id,
      chatId,
      userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000), // 5 minutes TTL
    };
    this.store.set(id, pending);
    logger.info({ id, chatId, userId }, 'Created pending unregister');
    return pending;
  }

  get(id: string): PendingUnregister | undefined {
    const pending = this.store.get(id);
    if (!pending) {
      return undefined;
    }
    if (pending.expiresAt < new Date()) {
      this.store.delete(id);
      logger.info({ id }, 'Pending unregister expired');
      return undefined;
    }
    return pending;
  }

  consume(id: string): PendingUnregister | undefined {
    const pending = this.get(id);
    if (pending) {
      this.store.delete(id);
      logger.info({ id }, 'Consumed pending unregister');
    }
    return pending;
  }

  delete(id: string): boolean {
    const existed = this.store.has(id);
    if (existed) {
      this.store.delete(id);
      logger.info({ id }, 'Deleted pending unregister');
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
      logger.info({ count }, 'Cleaned up expired pending unregisters');
    }
    return count;
  }
}

export const pendingUnregisterStore = new PendingUnregisterStore();