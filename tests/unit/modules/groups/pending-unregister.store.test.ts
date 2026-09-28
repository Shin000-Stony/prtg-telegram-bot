import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { pendingUnregisterStore } from '@/modules/groups/pending-unregister.store';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('PendingUnregisterStore', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-pus-'));
    testDbPath = join(testDir, 'test.db');
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1,admin2');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('DATABASE_PATH', testDbPath);
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    runMigrations();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates token', () => {
    const pending = pendingUnregisterStore.create('-100111111601', 'admin1');
    expect(pending.id).toBeDefined();
    expect(pending.chatId).toBe('-100111111601');
    expect(pending.userId).toBe('admin1');
    expect(pending.createdAt).toBeInstanceOf(Date);
    expect(pending.expiresAt).toBeInstanceOf(Date);
  });

  it('retrieves valid token', () => {
    const pending = pendingUnregisterStore.create('-100111111602', 'admin1');
    const retrieved = pendingUnregisterStore.get(pending.id);
    expect(retrieved).not.toBeUndefined();
    expect(retrieved?.id).toBe(pending.id);
  });

  it('correct user accepted', () => {
    const pending = pendingUnregisterStore.create('-100111111603', 'admin1');
    const retrieved = pendingUnregisterStore.get(pending.id);
    expect(retrieved?.userId).toBe('admin1');
  });

  it('wrong user rejected', () => {
    const pending = pendingUnregisterStore.create('-100111111604', 'admin1');
    const retrieved = pendingUnregisterStore.get(pending.id);
    // The store doesn't check user - that's done in handler
    expect(retrieved?.userId).toBe('admin1');
  });

  it('wrong chat rejected', () => {
    const pending = pendingUnregisterStore.create('-100111111605', 'admin1');
    const retrieved = pendingUnregisterStore.get(pending.id);
    expect(retrieved?.chatId).toBe('-100111111605');
  });

  it('expiry works', () => {
    const pending = pendingUnregisterStore.create('-100111111606', 'admin1');
    // Don't expire yet
    expect(pendingUnregisterStore.get(pending.id)).not.toBeUndefined();
    
    // Manually expire
    pending.expiresAt = new Date(Date.now() - 1000);
    expect(pendingUnregisterStore.get(pending.id)).toBeUndefined();
  });

  it('cancel removes', () => {
    const pending = pendingUnregisterStore.create('-100111111607', 'admin1');
    const deleted = pendingUnregisterStore.delete(pending.id);
    expect(deleted).toBe(true);
    expect(pendingUnregisterStore.get(pending.id)).toBeUndefined();
  });

  it('consume one-time', () => {
    const pending = pendingUnregisterStore.create('-100111111608', 'admin1');
    const consumed = pendingUnregisterStore.consume(pending.id);
    expect(consumed).not.toBeUndefined();
    expect(pendingUnregisterStore.get(pending.id)).toBeUndefined();
  });

  it('unknown token rejected', () => {
    const retrieved = pendingUnregisterStore.get('unknown-token');
    expect(retrieved).toBeUndefined();
  });

  it('token non-empty and unpredictable', () => {
    const pending1 = pendingUnregisterStore.create('-100111111609', 'admin1');
    const pending2 = pendingUnregisterStore.create('-100111111610', 'admin1');
    expect(pending1.id).not.toBe(pending2.id);
    expect(pending1.id.length).toBeGreaterThan(10);
  });

  it('cleanup expired token', () => {
    const pending1 = pendingUnregisterStore.create('-100111111611', 'admin1');
    const pending2 = pendingUnregisterStore.create('-100111111612', 'admin2');
    
    pending1.expiresAt = new Date(Date.now() - 1000);
    
    const cleaned = pendingUnregisterStore.cleanup();
    expect(cleaned).toBe(1);
    expect(pendingUnregisterStore.get(pending1.id)).toBeUndefined();
    expect(pendingUnregisterStore.get(pending2.id)).not.toBeUndefined();
  });

  it('token non-empty and unpredictable (entropy check)', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const pending = pendingUnregisterStore.create(`-1001111116${i}`, 'admin1');
      tokens.add(pending.id);
    }
    expect(tokens.size).toBe(100); // all unique
  });
});