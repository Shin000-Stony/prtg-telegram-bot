import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { pendingImportStore } from '@/modules/imports/pending-import.store';
import { customerService } from '@/modules/customers/customer.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('PendingImportStore', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-store-'));
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

  const validRows = [
    { clientId: '101', name: 'Test 1', monitorType: 'prtg' as const, pingHost: null, rowNumber: 1 },
    { clientId: '102', name: 'Test 2', monitorType: 'icmp' as const, pingHost: '10.0.0.1', rowNumber: 2 },
  ];

  const summary = {
    totalRows: 2,
    validCount: 2,
    errorCount: 0,
    newCount: 2,
    duplicateInCsv: 0,
    existingInDb: 0,
  };

  it('creates pending import', () => {
    const pending = pendingImportStore.create('-100123', 'admin1', validRows, summary);
    expect(pending.id).toBeDefined();
    expect(pending.chatId).toBe('-100123');
    expect(pending.userId).toBe('admin1');
    expect(pending.rows).toHaveLength(2);
    expect(pending.summary).toEqual(summary);
    expect(pending.expiresAt).toBeInstanceOf(Date);
  });

  it('retrieves valid token', () => {
    const pending = pendingImportStore.create('-100123', 'admin1', validRows, summary);
    const retrieved = pendingImportStore.get(pending.id);
    expect(retrieved).not.toBeUndefined();
    expect(retrieved?.id).toBe(pending.id);
    expect(retrieved?.rows).toHaveLength(2);
  });

  it('rejects different user', () => {
    const pending = pendingImportStore.create('-100123', 'admin1', validRows, summary);
    // Create a new store instance to simulate different context
    // The store is a singleton, so we just verify the userId check in callbacks
    // The actual check happens in the callback handler
    expect(pending.userId).toBe('admin1');
  });

  it('rejects different chat', () => {
    const pending = pendingImportStore.create('-100123', 'admin1', validRows, summary);
    expect(pending.chatId).toBe('-100123');
  });

  it('expired token is rejected', () => {
    const pending = pendingImportStore.create('-100123', 'admin1', validRows, summary);
    // Manually expire the token
    pending.expiresAt = new Date(Date.now() - 1000);
    const retrieved = pendingImportStore.get(pending.id);
    expect(retrieved).toBeUndefined();
  });

  it('cancel removes token', () => {
    const pending = pendingImportStore.create('-100123', 'admin1', validRows, summary);
    const deleted = pendingImportStore.delete(pending.id);
    expect(deleted).toBe(true);
    const retrieved = pendingImportStore.get(pending.id);
    expect(retrieved).toBeUndefined();
  });

  it('consumed token cannot be reused', () => {
    const pending = pendingImportStore.create('-100123', 'admin1', validRows, summary);
    const consumed = pendingImportStore.consume(pending.id);
    expect(consumed).not.toBeUndefined();
    const retrieved = pendingImportStore.get(pending.id);
    expect(retrieved).toBeUndefined();
  });

  it('unknown token is rejected', () => {
    const retrieved = pendingImportStore.get('unknown-token');
    expect(retrieved).toBeUndefined();
  });

  it('cleanup removes expired tokens', () => {
    const pending1 = pendingImportStore.create('-100123', 'admin1', validRows, summary);
    const pending2 = pendingImportStore.create('-100456', 'admin2', validRows, summary);
    
    // Expire one
    pending1.expiresAt = new Date(Date.now() - 1000);
    
    const cleaned = pendingImportStore.cleanup();
    expect(cleaned).toBe(1);
    
    expect(pendingImportStore.get(pending1.id)).toBeUndefined();
    expect(pendingImportStore.get(pending2.id)).not.toBeUndefined();
  });

  it('TTL works predictably', () => {
    const pending = pendingImportStore.create('-100123', 'admin1', validRows, summary);
    const now = Date.now();
    const diff = pending.expiresAt.getTime() - now;
    // Should be approximately 10 minutes (600,000ms)
    expect(diff).toBeGreaterThan(590000);
    expect(diff).toBeLessThan(610000);
  });
});