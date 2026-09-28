import Database from 'better-sqlite3';
import { getConfig } from '../../config/env';
import { getLogger } from '../../core/logger';
import { AppError } from '../../core/errors/app-error';

let dbInstance: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const config = getConfig();
  const logger = getLogger();

  try {
    dbInstance = new Database(config.DATABASE_PATH);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    dbInstance.pragma('busy_timeout = 5000');

    logger.info({ path: config.DATABASE_PATH }, 'Database connection established');
    return dbInstance;
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to database');
    throw AppError.database('Failed to connect to database', { originalError: String(error) });
  }
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    getLogger().info('Database connection closed');
  }
}

export function resetDatabaseForTesting(): void {
  closeDatabase();
  dbInstance = null;
}

export function runInTransaction<T>(fn: (db: Database.Database) => T): T {
  const db = getDatabase();
  const transaction = db.transaction(fn);
  return transaction(db);
}