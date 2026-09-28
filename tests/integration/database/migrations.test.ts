import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting, getDatabase } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations, getMigrationStatus } from '@/infrastructure/database/migration-runner';
import { customerRepository } from '@/modules/customers/customer.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import { MonitoringRepository } from '@/modules/monitoring/monitoring.repository';
import type { MonitoringState } from '@/modules/monitoring/monitoring.types';
import * as fs from 'fs';
import * as path from 'path';

describe('Database & Migrations', () => {
  const TEST_DB_DIR = '/home/shin/Documents/Monitoring_PRTG/prtg_telegram_bot/data';

  beforeEach((ctx) => {
    const testName = ctx.task.name || 'test';
    const safeName = testName.replace(/[^a-zA-Z0-9]/g, '_');
    const testId = Math.random().toString(36).substring(2, 8);
    const TEST_DB_PATH = path.join(TEST_DB_DIR, `test_migrations_${safeName}_${testId}.db`);
    vi.stubEnv('DATABASE_PATH', TEST_DB_PATH);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1,admin2');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    // Store the path for cleanup
    (globalThis as any).__TEST_DB_PATH__ = TEST_DB_PATH;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetDatabaseForTesting();
    // Delete the test database file to ensure clean state for next test
    const testPath = (globalThis as any).__TEST_DB_PATH__;
    if (testPath) {
      try {
        if (fs.existsSync(testPath)) {
          fs.unlinkSync(testPath);
        }
        const walPath = testPath + '-wal';
        const shmPath = testPath + '-shm';
        if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
        if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      } catch {
        // Ignore cleanup errors
      }
      delete (globalThis as any).__TEST_DB_PATH__;
    }
  });

  it('applies migration to empty database', () => {
    runMigrations();

    const db = getDatabase();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all() as { name: string }[];

    const tableNames = tables.map(t => t.name).sort();
    expect(tableNames).toEqual([
      'alert_outbox',
      'customers',
      'group_customer_access',
      'monitoring_states',
      'prtg_mappings',
      'schema_migrations',
      'telegram_groups',
    ]);
  });

  it('migration tracking works', () => {
    runMigrations();

    const status = getMigrationStatus();
    expect(status.length).toBe(5);
    expect(status[0].version).toBe(1);
    expect(status[0].applied).toBe(true);
    expect(status[1].version).toBe(2);
    expect(status[1].applied).toBe(true);
    expect(status[2].version).toBe(3);
    expect(status[2].applied).toBe(true);
    expect(status[3].version).toBe(4);
    expect(status[3].applied).toBe(true);
    expect(status[4].version).toBe(5);
    expect(status[4].applied).toBe(true);
  });

  it('running migrations twice is safe', () => {
    runMigrations();
    runMigrations();

    const status = getMigrationStatus();
    expect(status[0].applied).toBe(true);
    expect(status[1].applied).toBe(true);
    expect(status[2].applied).toBe(true);
    expect(status[3].applied).toBe(true);
  });

  it('required tables exist with correct schema', () => {
    runMigrations();

    const db = getDatabase();

    const customersSchema = db.prepare("PRAGMA table_info(customers)").all() as { name: string; notnull: number; pk: number }[];
    expect(customersSchema.some(c => c.name === 'id' && c.pk === 1)).toBe(true);
    expect(customersSchema.some(c => c.name === 'client_id' && c.notnull === 1)).toBe(true);
    expect(customersSchema.some(c => c.name === 'name' && c.notnull === 1)).toBe(true);
    expect(customersSchema.some(c => c.name === 'monitor_type' && c.notnull === 1)).toBe(true);

    const groupsSchema = db.prepare("PRAGMA table_info(telegram_groups)").all() as { name: string; pk: number }[];
    expect(groupsSchema.some(c => c.name === 'chat_id' && c.pk === 1)).toBe(true);

    const accessSchema = db.prepare("PRAGMA table_info(group_customer_access)").all() as { name: string }[];
    const accessColumns = accessSchema.map(c => c.name);
    expect(accessColumns).toContain('group_chat_id');
    expect(accessColumns).toContain('customer_id');
    expect(accessColumns).toContain('can_view');
    expect(accessColumns).toContain('receive_alerts');

    const mappingsSchema = db.prepare("PRAGMA table_info(prtg_mappings)").all() as { name: string }[];
    const mappingColumns = mappingsSchema.map(c => c.name);
    expect(mappingColumns).toContain('customer_id');
    expect(mappingColumns).toContain('prtg_object_id');
    expect(mappingColumns).toContain('mapping_method');
    expect(mappingColumns).toContain('verified');
  });

  it('unique client_id constraint works', () => {
    runMigrations();

    customerRepository.create({ clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
    expect(() => customerRepository.create({ clientId: 'C001', name: 'Test2', monitorType: 'icmp', pingHost: null, enabled: true }))
      .toThrow();
  });

  it('unique group/customer assignment works', () => {
    runMigrations();

    const customer = customerRepository.create({ clientId: 'C001', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
    groupRepository.upsert('-100123', 'Test Group');
    groupRepository.assignCustomer({ groupChatId: '-100123', customerId: customer.id, canView: true, receiveAlerts: false });

    const updated = groupRepository.assignCustomer({ groupChatId: '-100123', customerId: customer.id, canView: false, receiveAlerts: true });
    expect(updated.canView).toBe(false);
    expect(updated.receiveAlerts).toBe(true);
  });

  it('foreign key constraints enforced', () => {
    runMigrations();

    groupRepository.upsert('-100123', 'Test Group');
    expect(() => groupRepository.assignCustomer({ groupChatId: '-100123', customerId: 99999, canView: true, receiveAlerts: false }))
      .toThrow();
  });

  it('migration004 adds observation identity columns to monitoring_states (F3)', () => {
    runMigrations();

    const db = getDatabase();
    const columns = db.prepare("PRAGMA table_info(monitoring_states)").all() as { name: string; type: string }[];

    expect(columns.some(c => c.name === 'last_processed_generation' && c.type === 'INTEGER')).toBe(true);
    expect(columns.some(c => c.name === 'last_processed_observation_id' && c.type === 'TEXT')).toBe(true);
  });

  it('monitoring_states upsert preserves observation identity across restarts (F3)', () => {
    runMigrations();

    customerRepository.create({ clientId: 'C_F3', name: 'F3 Customer', monitorType: 'prtg', pingHost: null, enabled: true });
    const c = customerRepository.findByClientId('C_F3');

    const db = getDatabase();
    db.prepare(`
      INSERT INTO monitoring_states (customer_id, monitor_type, target_fingerprint, stable_health, latest_observation,
        last_attempt_at, observed_at, consecutive_count, last_processed_generation, last_processed_observation_id)
      VALUES (?, 'prtg', 'prtg|1||1001', 'UP', 'UP', 1000, 1000, 2, 5, 'prtg|5|1001|1000')
    `).run(c.id);

    const row = db.prepare(
      'SELECT last_processed_generation, last_processed_observation_id FROM monitoring_states WHERE customer_id = 1'
    ).get() as { last_processed_generation: number; last_processed_observation_id: string };

    expect(row.last_processed_generation).toBe(5);
    expect(row.last_processed_observation_id).toBe('prtg|5|1001|1000');
  });

  it('repository upsertBatch rolls back on failure and retries successfully (F3)', () => {
    runMigrations();

    // Create two customers
    customerRepository.create({ clientId: 'C_ROLL1', name: 'Rollback 1', monitorType: 'prtg', pingHost: null, enabled: true });
    customerRepository.create({ clientId: 'C_ROLL2', name: 'Rollback 2', monitorType: 'prtg', pingHost: null, enabled: true });
    const c1 = customerRepository.findByClientId('C_ROLL1')!;
    const c2 = customerRepository.findByClientId('C_ROLL2')!;

    const repo = new MonitoringRepository();

    // Seed existing identity for c1 (simulating prior run)
    const seedState1: MonitoringState = {
      customerId: c1.id,
      monitorType: 'prtg',
      targetFingerprint: 'prtg|1||1001',
      stableHealth: 'UP',
      latestObservation: 'UP',
      latestReason: 'up',
      latestRawStatus: 3,
      observedAt: 1000,
      lastAttemptAt: 1000,
      lastObservationAt: 1000,
      lastGoodObservationAt: 1000,
      consecutiveCount: 2,
      stableChangedAt: 1000,
      lastTransitionKind: null,
      lastTransitionAt: null,
      lastProcessedGeneration: 5,
      lastProcessedObservationId: 'prtg|5|1001|1000',
    };
    repo.upsertBatch([seedState1]);

    // Verify seed inserted
    let row1 = getDatabase().prepare('SELECT * FROM monitoring_states WHERE customer_id = ?').get(c1.id);
    expect(row1).toBeTruthy();
    expect((row1 as Record<string, unknown>).last_processed_observation_id).toBe('prtg|5|1001|1000');

    // Now test rollback: batch with valid row1 (update) and invalid row2 (FK violation - customer_id 99999)
    const updateState1: MonitoringState = {
      ...seedState1,
      lastProcessedGeneration: 6,
      lastProcessedObservationId: 'prtg|6|1001|2000',
    };

    const invalidState2: MonitoringState = {
      customerId: 99999, // Non-existent customer - FK violation
      monitorType: 'prtg',
      targetFingerprint: 'prtg|1||1002',
      stableHealth: 'UP',
      latestObservation: 'UP',
      latestReason: 'up',
      latestRawStatus: 3,
      observedAt: 2000,
      lastAttemptAt: 2000,
      lastObservationAt: 2000,
      lastGoodObservationAt: 2000,
      consecutiveCount: 2,
      stableChangedAt: 2000,
      lastTransitionKind: null,
      lastTransitionAt: null,
      lastProcessedGeneration: 6,
      lastProcessedObservationId: 'prtg|6|1002|3000',
    };

    // This should throw due to FK violation on second row
    expect(() => repo.upsertBatch([updateState1, invalidState2])).toThrow();

    // Verify rollback: row1 identity unchanged (still generation 5)
    row1 = getDatabase().prepare('SELECT * FROM monitoring_states WHERE customer_id = ?').get(c1.id);
    expect(row1).toBeTruthy();
    expect((row1 as Record<string, unknown>).last_processed_generation).toBe(5);
    expect((row1 as Record<string, unknown>).last_processed_observation_id).toBe('prtg|5|1001|1000');
    // row2 should not exist
    let row2 = getDatabase().prepare('SELECT * FROM monitoring_states WHERE customer_id = ?').get(c2.id);
    expect(row2).toBeFalsy();

    // Retry with valid data for both rows
    const validState2: MonitoringState = {
      customerId: c2.id,
      monitorType: 'prtg',
      targetFingerprint: 'prtg|1||1002',
      stableHealth: 'UP',
      latestObservation: 'UP',
      latestReason: 'up',
      latestRawStatus: 3,
      observedAt: 2000,
      lastAttemptAt: 2000,
      lastObservationAt: 2000,
      lastGoodObservationAt: 2000,
      consecutiveCount: 2,
      stableChangedAt: 2000,
      lastTransitionKind: null,
      lastTransitionAt: null,
      lastProcessedGeneration: 6,
      lastProcessedObservationId: 'prtg|6|1002|3000',
    };
    repo.upsertBatch([updateState1, validState2]);

    // Verify both updated correctly
    row1 = getDatabase().prepare('SELECT * FROM monitoring_states WHERE customer_id = ?').get(c1.id);
    row2 = getDatabase().prepare('SELECT * FROM monitoring_states WHERE customer_id = ?').get(c2.id);
    expect(row1).toBeTruthy();
    expect(row2).toBeTruthy();
    expect((row1 as Record<string, unknown>).last_processed_generation).toBe(6);
    expect((row1 as Record<string, unknown>).last_processed_observation_id).toBe('prtg|6|1001|2000');
    expect((row2 as Record<string, unknown>).last_processed_generation).toBe(6);
    expect((row2 as Record<string, unknown>).last_processed_observation_id).toBe('prtg|6|1002|3000');
  });
});