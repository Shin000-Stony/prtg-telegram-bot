import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { pendingDeleteStore } from '@/modules/customers/pending-delete.store';
import { customerRepository } from '@/modules/customers/customer.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('PendingDeleteStore', () => {
  let testDir: string;
  let testDbPath: string;

  const ADMIN_USER_ID = '123456789';
  const GLOBAL_GROUP_ID = '-1001234567890';

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-pd-store-'));
    testDbPath = join(testDir, 'test.db');
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', ADMIN_USER_ID);
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', GLOBAL_GROUP_ID);
    vi.stubEnv('DATABASE_PATH', testDbPath);
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
    pendingDeleteStore.clear();
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates session with customer context', () => {
    const customer = customerRepository.create({
      clientId: 'DEL-TEST-001',
      name: 'Test Customer',
      monitorType: 'prtg',
      pingHost: null,
      enabled: true,
    });

    const session = pendingDeleteStore.create({
      customerId: customer.id,
      clientId: customer.clientId,
      name: customer.name,
      chatId: GLOBAL_GROUP_ID,
      userId: ADMIN_USER_ID,
    });

    expect(session.id).toBeDefined();
    expect(session.id.length).toBeGreaterThan(10);
    expect(session.customerId).toBe(customer.id);
    expect(session.clientId).toBe('DEL-TEST-001');
    expect(session.name).toBe('Test Customer');
    expect(session.chatId).toBe(GLOBAL_GROUP_ID);
    expect(session.userId).toBe(ADMIN_USER_ID);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.expiresAt).toBeInstanceOf(Date);
    expect(session.expiresAt.getTime()).toBeGreaterThan(session.createdAt.getTime());
  });

  it('retrieves valid session', () => {
    const customer = customerRepository.create({
      clientId: 'DEL-TEST-002',
      name: 'Retrieve Test',
      monitorType: 'prtg',
      pingHost: null,
      enabled: true,
    });

    const session = pendingDeleteStore.create({
      customerId: customer.id,
      clientId: customer.clientId,
      name: customer.name,
      chatId: GLOBAL_GROUP_ID,
      userId: ADMIN_USER_ID,
    });

    const retrieved = pendingDeleteStore.get(session.id);
    expect(retrieved).not.toBeUndefined();
    expect(retrieved?.id).toBe(session.id);
    expect(retrieved?.customerId).toBe(customer.id);
  });

  it('rejects unknown token', () => {
    const retrieved = pendingDeleteStore.get('nonexistent-token');
    expect(retrieved).toBeUndefined();
  });

  it('consumes token one-time (get returns undefined after consume)', () => {
    const session = pendingDeleteStore.create({
      customerId: 1,
      clientId: 'CONSUME-TEST',
      name: 'Consume Test',
      chatId: GLOBAL_GROUP_ID,
      userId: ADMIN_USER_ID,
    });

    const consumed = pendingDeleteStore.consume(session.id);
    expect(consumed).not.toBeUndefined();
    expect(consumed?.id).toBe(session.id);

    // Token should no longer be retrievable
    expect(pendingDeleteStore.get(session.id)).toBeUndefined();
  });

  it('consume returns undefined for unknown token', () => {
    const consumed = pendingDeleteStore.consume('unknown-token');
    expect(consumed).toBeUndefined();
  });

  it('deletes session explicitly', () => {
    const session = pendingDeleteStore.create({
      customerId: 1,
      clientId: 'DELETE-TEST',
      name: 'Delete Test',
      chatId: GLOBAL_GROUP_ID,
      userId: ADMIN_USER_ID,
    });

    const deleted = pendingDeleteStore.delete(session.id);
    expect(deleted).toBe(true);
    expect(pendingDeleteStore.get(session.id)).toBeUndefined();
  });

  it('delete returns false for unknown token', () => {
    const deleted = pendingDeleteStore.delete('unknown-token');
    expect(deleted).toBe(false);
  });

  it('expired session is not returned by get', () => {
    const session = pendingDeleteStore.create({
      customerId: 1,
      clientId: 'EXPIRE-TEST',
      name: 'Expire Test',
      chatId: GLOBAL_GROUP_ID,
      userId: ADMIN_USER_ID,
    });

    session.expiresAt = new Date(Date.now() - 1000);

    expect(pendingDeleteStore.get(session.id)).toBeUndefined();
  });

  it('cleanup removes expired sessions', () => {
    const session1 = pendingDeleteStore.create({
      customerId: 1,
      clientId: 'EXPIRE-001',
      name: 'Expire 1',
      chatId: GLOBAL_GROUP_ID,
      userId: ADMIN_USER_ID,
    });
    const session2 = pendingDeleteStore.create({
      customerId: 2,
      clientId: 'EXPIRE-002',
      name: 'Expire 2',
      chatId: GLOBAL_GROUP_ID,
      userId: ADMIN_USER_ID,
    });

    session1.expiresAt = new Date(Date.now() - 1000);

    const cleaned = pendingDeleteStore.cleanup();
    expect(cleaned).toBe(1);
    expect(pendingDeleteStore.get(session1.id)).toBeUndefined();
    expect(pendingDeleteStore.get(session2.id)).not.toBeUndefined();
  });

  it('generates unique tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const session = pendingDeleteStore.create({
        customerId: i,
        clientId: `UNIQ-${i}`,
        name: `Customer ${i}`,
        chatId: GLOBAL_GROUP_ID,
        userId: ADMIN_USER_ID,
      });
      tokens.add(session.id);
    }
    expect(tokens.size).toBe(100);
  });
});
