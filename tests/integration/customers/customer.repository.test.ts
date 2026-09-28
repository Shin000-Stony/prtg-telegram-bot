import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting, getDatabase } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { customerRepository } from '@/modules/customers/customer.repository';
import { AppError } from '@/core/errors/app-error';

describe('CustomerRepository Integration', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1,admin2');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
  });

  it('creates a customer', () => {
    const created = customerRepository.create({
      clientId: 'REPO-001',
      name: 'Repo Test',
      monitorType: 'prtg',
      pingHost: null,
      enabled: true,
    });
    expect(created.clientId).toBe('REPO-001');
    expect(created.name).toBe('Repo Test');
    expect(created.monitorType).toBe('prtg');
    expect(created.enabled).toBe(true);
    expect(created.id).toBeDefined();
    expect(typeof created.id).toBe('number');
  });

  it('finds customer by internal id', () => {
    const created = customerRepository.create({
      clientId: 'REPO-002',
      name: 'Find By ID',
      monitorType: 'icmp',
      pingHost: '10.0.0.1',
      enabled: true,
    });
    const found = customerRepository.findById(created.id);
    expect(found).not.toBeNull();
    expect(found?.clientId).toBe('REPO-002');
    expect(found?.pingHost).toBe('10.0.0.1');
  });

  it('finds customer by client_id', () => {
    customerRepository.create({
      clientId: 'REPO-003',
      name: 'Find By ClientId',
      monitorType: 'pic',
      pingHost: null,
      enabled: true,
    });
    const found = customerRepository.findByClientId('REPO-003');
    expect(found).not.toBeNull();
    expect(found?.clientId).toBe('REPO-003');
    expect(found?.monitorType).toBe('pic');
  });

  it('returns null for unknown id', () => {
    const found = customerRepository.findById(99999);
    expect(found).toBeNull();
  });

  it('returns null for unknown client_id', () => {
    const found = customerRepository.findByClientId('unknown');
    expect(found).toBeNull();
  });

  it('finds all customers with filters', () => {
    customerRepository.create({ clientId: 'FLT-1', name: 'Alpha', monitorType: 'prtg', pingHost: null, enabled: true });
    customerRepository.create({ clientId: 'FLT-2', name: 'Beta', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true });
    customerRepository.create({ clientId: 'FLT-3', name: 'Gamma', monitorType: 'prtg', pingHost: null, enabled: false });

    const all = customerRepository.findAll({});
    expect(all.total).toBeGreaterThanOrEqual(3);

    const enabled = customerRepository.findAll({ enabled: true });
    expect(enabled.items.every(c => c.enabled)).toBe(true);

    const prtg = customerRepository.findAll({ monitorType: 'prtg' });
    expect(prtg.items.every(c => c.monitorType === 'prtg')).toBe(true);

    const search = customerRepository.findAll({ search: 'Alpha' });
    expect(search.items.some(c => c.name.includes('Alpha'))).toBe(true);
  });

  it('updates customer', () => {
    const created = customerRepository.create({
      clientId: 'UPD-001',
      name: 'Original',
      monitorType: 'prtg',
      pingHost: null,
      enabled: true,
    });

    const updated = customerRepository.update(created.id, { name: 'Updated', enabled: false });
    expect(updated).not.toBeNull();
    expect(updated?.name).toBe('Updated');
    expect(updated?.enabled).toBe(false);
    expect(updated?.clientId).toBe('UPD-001');
  });

  it('returns null when updating non-existent id', () => {
    const updated = customerRepository.update(99999, { name: 'Test' });
    expect(updated).toBeNull();
  });

  it('enforces UNIQUE client_id constraint', () => {
    customerRepository.create({ clientId: 'UNQ-001', name: 'First', monitorType: 'prtg', pingHost: null, enabled: true });
    expect(() => customerRepository.create({
      clientId: 'UNQ-001',
      name: 'Second',
      monitorType: 'icmp',
      pingHost: '10.0.0.1',
      enabled: true,
    })).toThrow();
  });

  it('bulkCreate succeeds for valid inputs', () => {
    const created = customerRepository.bulkCreate([
      { clientId: 'BLK-1', name: 'Bulk 1', monitorType: 'prtg', pingHost: null, enabled: true },
      { clientId: 'BLK-2', name: 'Bulk 2', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true },
    ]);
    expect(created.length).toBe(2);
    expect(created[0].clientId).toBe('BLK-1');
    expect(created[1].clientId).toBe('BLK-2');
  });

  it('bulkCreate rolls back when one insert fails', () => {
    customerRepository.create({ clientId: 'BLK-EXIST', name: 'Existing', monitorType: 'prtg', pingHost: null, enabled: true });
    
    expect(() => customerRepository.bulkCreate([
      { clientId: 'BLK-NEW', name: 'New', monitorType: 'prtg', pingHost: null, enabled: true },
      { clientId: 'BLK-EXIST', name: 'Duplicate', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true },
    ])).toThrow();

    const count = getDatabase().prepare('SELECT COUNT(*) as c FROM customers WHERE client_id IN (?, ?)').get('BLK-NEW', 'BLK-EXIST') as { c: number };
    expect(count.c).toBe(1);
  });

  it('deletes customer', () => {
    const created = customerRepository.create({
      clientId: 'DEL-001',
      name: 'To Delete',
      monitorType: 'prtg',
      pingHost: null,
      enabled: true,
    });
    const deleted = customerRepository.delete(created.id);
    expect(deleted).toBe(true);
    expect(customerRepository.findById(created.id)).toBeNull();
  });

  it('returns false when deleting non-existent id', () => {
    const deleted = customerRepository.delete(99999);
    expect(deleted).toBe(false);
  });
});