import fs from 'fs';
import path from 'path';
import { getDatabase } from './database';
import { getLogger } from '../../core/logger';
import { AppError } from '../../core/errors/app-error';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

function loadMigrations(): Migration[] {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((file) => {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Invalid migration filename: ${file}`);
    }
    const version = parseInt(match[1], 10);
    const name = match[2];
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    return { version, name, sql };
  });
}

function ensureMigrationTable(db: ReturnType<typeof getDatabase>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function getAppliedMigrations(db: ReturnType<typeof getDatabase>): Set<number> {
  try {
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
    return new Set(rows.map((r) => r.version));
  } catch {
    // Table doesn't exist yet
    return new Set();
  }
}

export function runMigrations(): void {
  const logger = getLogger();
  const db = getDatabase();

  ensureMigrationTable(db);
  const migrations = loadMigrations();
  const applied = getAppliedMigrations(db);

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      logger.debug({ version: migration.version, name: migration.name }, 'Migration already applied');
      continue;
    }

    logger.info({ version: migration.version, name: migration.name }, 'Applying migration');

    try {
      db.exec(migration.sql);
      // Use INSERT OR IGNORE to handle concurrent migration attempts
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
      logger.info({ version: migration.version, name: migration.name }, 'Migration applied successfully');
    } catch (error) {
      logger.error({ err: error, version: migration.version }, 'Migration failed');
      throw AppError.database(`Migration ${migration.version} failed`, { originalError: String(error) });
    }
  }

  logger.info('All migrations applied');
}

export function getMigrationStatus(): { version: number; name: string; applied: boolean }[] {
  const db = getDatabase();
  ensureMigrationTable(db);
  const migrations = loadMigrations();
  const applied = getAppliedMigrations(db);

  return migrations.map((m) => ({
    version: m.version,
    name: m.name,
    applied: applied.has(m.version),
  }));
}

export function resetMigrationsForTesting(): void {
  try {
    const db = getDatabase();
    db.exec('DROP TABLE IF EXISTS monitoring_states');
    db.exec('DROP TABLE IF EXISTS prtg_mappings');
    db.exec('DROP TABLE IF EXISTS group_customer_access');
    db.exec('DROP TABLE IF EXISTS telegram_groups');
    db.exec('DROP TABLE IF EXISTS customers');
    db.exec('DROP TABLE IF EXISTS schema_migrations');
  } catch {
    // Ignore errors during test reset
  }
}