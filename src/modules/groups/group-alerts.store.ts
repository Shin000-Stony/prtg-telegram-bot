import { getLogger } from '../../core/logger';
import { randomBytes } from 'crypto';

const logger = getLogger().child({ module: 'GroupAlertsStore' });

const TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 200;
const TOKEN_BYTES = 16;
const PREVIEW_ID_BYTES = 16;
const MAX_ATTEMPTS = 10;

export type GroupAlertsState = 'idle' | 'pending' | 'executing';

export interface GroupAlertsCustomer {
  customerId: number;
  clientId: string;
  name: string;
  monitorType: string;
  canView: boolean;
  enabled: boolean;
  receiveAlerts: boolean;
}

export interface GroupAlertsPreview {
  previewId: string;
  action: 'enable_all' | 'disable_all';
  targetIds: number[];
  affectedIds: number[];
  createdAt: Date;
}

export interface GroupAlertsSession {
  token: string;
  userId: string;
  chatId: string;
  messageId: number | null;
  isGlobalGroup: boolean;
  currentPage: number;
  customers: GroupAlertsCustomer[];
  currentPreview: GroupAlertsPreview | null;
  state: GroupAlertsState;
  createdAt: Date;
  expiresAt: Date;
}

export class GroupAlertsStore {
  private store = new Map<string, GroupAlertsSession>();

  create(data: Omit<GroupAlertsSession, 'token' | 'currentPage' | 'currentPreview' | 'state' | 'createdAt' | 'expiresAt'>): GroupAlertsSession {
    if (this.store.size >= MAX_SESSIONS) {
      this.cleanup();
      if (this.store.size >= MAX_SESSIONS) {
        throw new Error('Group alerts store is full; please retry later');
      }
    }

    const now = new Date();

    let token: string;
    let attempts = 0;
    do {
      token = randomBytes(TOKEN_BYTES).toString('base64url');
      attempts++;
      if (attempts > MAX_ATTEMPTS && this.store.has(token)) {
        throw new Error('Token collision after max attempts; please retry later');
      }
    } while (this.store.has(token));

    const session: GroupAlertsSession = {
      ...data,
      token,
      currentPage: 1,
      currentPreview: null,
      state: 'idle',
      createdAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    };
    this.store.set(token, session);
    logger.info({ token, userId: data.userId, chatId: data.chatId }, 'Created group alerts session');
    return session;
  }

  generatePreviewId(): string {
    return randomBytes(PREVIEW_ID_BYTES).toString('base64url');
  }

  get(token: string): GroupAlertsSession | undefined {
    const session = this.store.get(token);
    if (!session) {
      return undefined;
    }
    if (session.expiresAt < new Date()) {
      this.store.delete(token);
      logger.info({ token }, 'Group alerts session expired');
      return undefined;
    }
    return session;
  }

  delete(token: string): boolean {
    const existed = this.store.has(token);
    if (existed) {
      this.store.delete(token);
      logger.info({ token }, 'Deleted group alerts session');
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
      logger.info({ count }, 'Cleaned up expired group alerts sessions');
    }
    return count;
  }

  clear(): void {
    const size = this.store.size;
    this.store.clear();
    if (size > 0) {
      logger.info({ size }, 'Cleared all group alerts sessions');
    }
  }

  size(): number {
    this.cleanup();
    return this.store.size;
  }
}

export const groupAlertsStore = new GroupAlertsStore();

export const PAGE_SIZE = 8;