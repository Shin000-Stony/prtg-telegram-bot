import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { customerService } from '@/modules/customers/customer.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { AppError } from '@/core/errors/app-error';

describe('CustomerService', () => {
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

  describe('create', () => {
    it('creates valid PRTG customer', () => {
      const created = customerService.create({
        clientId: '101',
        name: 'Test PRTG',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });
      expect(created.clientId).toBe('101');
      expect(created.name).toBe('Test PRTG');
      expect(created.monitorType).toBe('prtg');
      expect(created.pingHost).toBeNull();
      expect(created.enabled).toBe(true);
      expect(created.id).toBeDefined();
    });

    it('creates valid ICMP customer with ping_host', () => {
      const created = customerService.create({
        clientId: '102',
        name: 'Test ICMP',
        monitorType: 'icmp',
        pingHost: '192.0.2.10',
        enabled: true,
      });
      expect(created.monitorType).toBe('icmp');
      expect(created.pingHost).toBe('192.0.2.10');
    });

    it('creates valid PIC customer', () => {
      const created = customerService.create({
        clientId: '103',
        name: 'Test PIC',
        monitorType: 'pic',
        pingHost: null,
        enabled: true,
      });
      expect(created.monitorType).toBe('pic');
    });

    it('creates valid disabled customer', () => {
      const created = customerService.create({
        clientId: '104',
        name: 'Test Disabled',
        monitorType: 'disabled',
        pingHost: null,
        enabled: false,
      });
      expect(created.monitorType).toBe('disabled');
      expect(created.enabled).toBe(false);
    });

    it('trims client_id', () => {
      const created = customerService.create({
        clientId: '  105  ',
        name: 'Test Trim',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });
      expect(created.clientId).toBe('105');
    });

    it('trims customer name', () => {
      const created = customerService.create({
        clientId: '106',
        name: '  Test Name Trim  ',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });
      expect(created.name).toBe('Test Name Trim');
    });

    it('rejects ICMP without ping_host', () => {
      expect(() => customerService.create({
        clientId: '107',
        name: 'Test ICMP No Host',
        monitorType: 'icmp',
        pingHost: null,
        enabled: true,
      })).toThrow(AppError);
    });

    it('rejects invalid monitor type', () => {
      expect(() => customerService.create({
        clientId: '108',
        name: 'Test Invalid',
        monitorType: 'invalid' as any,
        pingHost: null,
        enabled: true,
      })).toThrow(AppError);
    });

    it('rejects duplicate client_id', () => {
      customerService.create({
        clientId: '109',
        name: 'First',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });
      expect(() => customerService.create({
        clientId: '109',
        name: 'Second',
        monitorType: 'icmp',
        pingHost: '10.0.0.1',
        enabled: true,
      })).toThrow(AppError);
    });

    it('rejects empty client_id', () => {
      expect(() => customerService.create({
        clientId: '',
        name: 'Test',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      })).toThrow(AppError);
    });

    it('rejects empty name', () => {
      expect(() => customerService.create({
        clientId: '110',
        name: '',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      })).toThrow(AppError);
    });

    it('stores ping_host as null when empty string provided for PRTG', () => {
      const created = customerService.create({
        clientId: '111',
        name: 'Test PRTG Empty Host',
        monitorType: 'prtg',
        pingHost: '',
        enabled: true,
      });
      expect(created.pingHost).toBeNull();
    });
  });

  describe('getByClientId', () => {
    it('returns customer by client_id', () => {
      const created = customerService.create({
        clientId: '201',
        name: 'Test GetByClientId',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });
      const found = customerService.getByClientId('201');
      expect(found).not.toBeNull();
      expect(found?.clientId).toBe('201');
      expect(found?.id).toBe(created.id);
    });

    it('returns null for unknown client_id', () => {
      const found = customerService.getByClientId('unknown');
      expect(found).toBeNull();
    });
  });

  describe('getById', () => {
    it('returns customer by internal id', () => {
      const created = customerService.create({
        clientId: '202',
        name: 'Test GetById',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });
      const found = customerService.getById(created.id);
      expect(found).not.toBeNull();
      expect(found?.clientId).toBe('202');
    });

    it('returns null for unknown id', () => {
      const found = customerService.getById(99999);
      expect(found).toBeNull();
    });
  });

  describe('enable/disable', () => {
    it('enables a disabled customer', () => {
      const created = customerService.create({
        clientId: '301',
        name: 'Test Enable',
        monitorType: 'prtg',
        pingHost: null,
        enabled: false,
      });
      expect(created.enabled).toBe(false);

      const enabled = customerService.update(created.id, { enabled: true });
      expect(enabled.enabled).toBe(true);
      expect(enabled.id).toBe(created.id);
      expect(enabled.clientId).toBe('301');
    });

    it('disables an enabled customer', () => {
      const created = customerService.create({
        clientId: '302',
        name: 'Test Disable',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });
      expect(created.enabled).toBe(true);

      const disabled = customerService.update(created.id, { enabled: false });
      expect(disabled.enabled).toBe(false);
    });

    it('enabling already-enabled customer returns same state', () => {
      const created = customerService.create({
        clientId: '303',
        name: 'Test Already Enabled',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });
      const result = customerService.update(created.id, { enabled: true });
      expect(result.enabled).toBe(true);
      expect(result.id).toBe(created.id);
    });

    it('disabling already-disabled customer returns same state', () => {
      const created = customerService.create({
        clientId: '304',
        name: 'Test Already Disabled',
        monitorType: 'prtg',
        pingHost: null,
        enabled: false,
      });
      const result = customerService.update(created.id, { enabled: false });
      expect(result.enabled).toBe(false);
      expect(result.id).toBe(created.id);
    });

    it('throws for unknown customer id', () => {
      expect(() => customerService.update(99999, { enabled: true })).toThrow(AppError);
    });
  });

  describe('list', () => {
    it('returns all customers', () => {
      customerService.create({ clientId: '401', name: 'A', monitorType: 'prtg', pingHost: null, enabled: true });
      customerService.create({ clientId: '402', name: 'B', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true });
      const result = customerService.list({});
      expect(result.total).toBeGreaterThanOrEqual(2);
      expect(result.items.length).toBeGreaterThanOrEqual(2);
    });

    it('filters by enabled', () => {
      customerService.create({ clientId: '411', name: 'Enabled', monitorType: 'prtg', pingHost: null, enabled: true });
      customerService.create({ clientId: '412', name: 'Disabled', monitorType: 'prtg', pingHost: null, enabled: false });
      const result = customerService.list({ enabled: true });
      for (const c of result.items) {
        expect(c.enabled).toBe(true);
      }
    });

    it('filters by monitorType', () => {
      customerService.create({ clientId: '421', name: 'PRTG', monitorType: 'prtg', pingHost: null, enabled: true });
      customerService.create({ clientId: '422', name: 'ICMP', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true });
      const result = customerService.list({ monitorType: 'prtg' });
      for (const c of result.items) {
        expect(c.monitorType).toBe('prtg');
      }
    });

    it('filters by search', () => {
      customerService.create({ clientId: '431', name: 'Alpha Branch', monitorType: 'prtg', pingHost: null, enabled: true });
      customerService.create({ clientId: '432', name: 'Beta Branch', monitorType: 'prtg', pingHost: null, enabled: true });
      const result = customerService.list({ search: 'Alpha' });
      expect(result.items.some(c => c.name.includes('Alpha'))).toBe(true);
      expect(result.items.every(c => c.name.includes('Alpha'))).toBe(true);
    });

    it('paginates results', () => {
      for (let i = 0; i < 5; i++) {
        customerService.create({ clientId: `44${i}`, name: `Test ${i}`, monitorType: 'prtg', pingHost: null, enabled: true });
      }
      const page1 = customerService.list({ page: 1, pageSize: 2 });
      expect(page1.items.length).toBe(2);
      expect(page1.page).toBe(1);
      expect(page1.pageSize).toBe(2);
    });
  });

  describe('delete', () => {
    it('deletes existing customer', () => {
      const created = customerService.create({
        clientId: '501',
        name: 'To Delete',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });
      const deleted = customerService.delete(created.id);
      expect(deleted).toBe(true);
      expect(customerService.getById(created.id)).toBeNull();
    });

    it('returns false for unknown id', () => {
      const deleted = customerService.delete(99999);
      expect(deleted).toBe(false);
    });
  });

  describe('bulkCreate', () => {
    it('creates multiple customers', () => {
      const inputs = [
        { clientId: '601', name: 'Bulk 1', monitorType: 'prtg', pingHost: null, enabled: true },
        { clientId: '602', name: 'Bulk 2', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true },
      ];
      const created = customerService.bulkCreate(inputs);
      expect(created.length).toBe(2);
      expect(created[0].clientId).toBe('601');
      expect(created[1].clientId).toBe('602');
    });

    it('rejects if any client_id already exists', () => {
      customerService.create({ clientId: '611', name: 'Existing', monitorType: 'prtg', pingHost: null, enabled: true });
      expect(() => customerService.bulkCreate([
        { clientId: '612', name: 'New', monitorType: 'prtg', pingHost: null, enabled: true },
        { clientId: '611', name: 'Duplicate', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true },
      ])).toThrow(AppError);
    });

    it('rejects duplicate client_ids within same batch', () => {
      expect(() => customerService.bulkCreate([
        { clientId: '621', name: 'First', monitorType: 'prtg', pingHost: null, enabled: true },
        { clientId: '621', name: 'Duplicate in batch', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true },
      ])).toThrow(AppError);
    });
  });

  describe('getStats', () => {
    it('returns total count and breakdown by monitor type', () => {
      const stats = customerService.getStats();
      expect(stats.total).toBeGreaterThanOrEqual(0);
      expect(typeof stats.byMonitorType).toBe('object');
    });
  });

  describe('operator-facing operations use client_id', () => {
    it('create uses client_id as identifier', () => {
      const created = customerService.create({
        clientId: 'OPERATOR-TEST',
        name: 'Operator Test',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });
      expect(created.clientId).toBe('OPERATOR-TEST');
    });

    it('getByClientId is the primary lookup method', () => {
      customerService.create({ clientId: 'OP-LOOKUP', name: 'Op Lookup', monitorType: 'prtg', pingHost: null, enabled: true });
      const found = customerService.getByClientId('OP-LOOKUP');
      expect(found).not.toBeNull();
      expect(found?.clientId).toBe('OP-LOOKUP');
    });

    it('internal id is not used for operator operations', () => {
      const created = customerService.create({ clientId: 'OP-INTERNAL', name: 'Internal', monitorType: 'prtg', pingHost: null, enabled: true });
      expect(typeof created.id).toBe('number');
      expect(created.clientId).toBe('OP-INTERNAL');
    });
  });
});