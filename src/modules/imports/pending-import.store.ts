import type { ValidatedCsvRow } from './csv-import.types';
import { getLogger } from '../../core/logger';
import { randomUUID } from 'crypto';

const logger = getLogger().child({ module: 'PendingImportStore' });

export interface PendingImport {
  id: string;
  chatId: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  rows: ValidatedCsvRow[];
  summary: {
    totalRows: number;
    validCount: number;
    errorCount: number;
    newCount: number;
    duplicateInCsv: number;
    existingInDb: number;
  };
}

export class PendingImportStore {
  private store = new Map<string, PendingImport>();

  create(chatId: string, userId: string, rows: ValidatedCsvRow[], summary: PendingImport['summary']): PendingImport {
    const id = randomUUID();
    const now = new Date();
    const pending: PendingImport = {
      id,
      chatId,
      userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      rows,
      summary,
    };
    this.store.set(id, pending);
    logger.info({ id, chatId, userId, validCount: rows.length }, 'Created pending import');
    return pending;
  }

  get(id: string): PendingImport | undefined {
    const pending = this.store.get(id);
    if (!pending) {
      return undefined;
    }
    if (pending.expiresAt < new Date()) {
      this.store.delete(id);
      logger.info({ id }, 'Pending import expired');
      return undefined;
    }
    return pending;
  }

  consume(id: string): PendingImport | undefined {
    const pending = this.get(id);
    if (pending) {
      this.store.delete(id);
      logger.info({ id }, 'Consumed pending import');
    }
    return pending;
  }

  delete(id: string): boolean {
    const existed = this.store.has(id);
    if (existed) {
      this.store.delete(id);
      logger.info({ id }, 'Deleted pending import');
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
      logger.info({ count }, 'Cleaned up expired pending imports');
    }
    return count;
  }
}

export const pendingImportStore = new PendingImportStore();