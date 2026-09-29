import { getLogger } from '../../core/logger';
import { randomUUID } from 'crypto';

const logger = getLogger().child({ module: 'ClientsPaginationStore' });

const TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 200;

export interface ClientsSession {
  token: string;
  userId: string;
  chatId: string;
  messageId: number | null;
  keyword: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export class ClientsPaginationStore {
  private store = new Map<string, ClientsSession>();

  create(data: Omit<ClientsSession, 'token' | 'createdAt' | 'expiresAt'>): ClientsSession {
    if (this.store.size >= MAX_SESSIONS) {
      this.cleanup();
      if (this.store.size >= MAX_SESSIONS) {
        throw new Error('Clients pagination store is full; please retry later');
      }
    }

    const now = new Date();
    const token = randomUUID().slice(0, 8);
    const session: ClientsSession = {
      ...data,
      token,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    };
    this.store.set(token, session);
    logger.info({ token, userId: data.userId, chatId: data.chatId }, 'Created clients pagination session');
    return session;
  }

  get(token: string): ClientsSession | undefined {
    const session = this.store.get(token);
    if (!session) {
      return undefined;
    }
    if (session.expiresAt < new Date()) {
      this.store.delete(token);
      logger.info({ token }, 'Clients pagination session expired');
      return undefined;
    }
    return session;
  }

  delete(token: string): boolean {
    const existed = this.store.has(token);
    if (existed) {
      this.store.delete(token);
      logger.info({ token }, 'Deleted clients pagination session');
    }
    return existed;
  }

  cleanup(): number {
    const now = new Date();
    let count = 0;
    for (const [token, session] of this.store.entries()) {
      if (session.expiresAt < now) {
        this.store.delete(token);
        count++;
      }
    }
    if (count > 0) {
      logger.info({ count }, 'Cleaned up expired clients pagination sessions');
    }
    return count;
  }

  size(): number {
    this.cleanup();
    return this.store.size;
  }
}

export const clientsPaginationStore = new ClientsPaginationStore();
