import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { csvImportService } from '@/modules/imports/csv-import.service';
import { customerService } from '@/modules/customers/customer.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('CSV Preview Tests', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-csvprev-'));
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

  const validCsv = `client_id,name,monitor_type,ping_host
101,Test PRTG,prtg,
102,Test ICMP,icmp,192.0.2.10
103,Test PIC,pic,`;

  const csvWithErrors = `client_id,name,monitor_type,ping_host
101,Test PRTG,prtg,
,Missing Client,prtg,
103,Test Invalid,invalid,
104,Test ICMP No Host,icmp,`;

  describe('csvImportService.parse', () => {
    it('parses valid CSV', () => {
      const result = csvImportService.parse(validCsv);
      expect(result.validCount).toBe(3);
      expect(result.errorCount).toBe(0);
      expect(result.totalRows).toBe(3);
    });

it('captures errors for invalid rows', () => {
      const result = csvImportService.parse(csvWithErrors);
      expect(result.validCount).toBe(1); // only 101 is valid
      expect(result.errorCount).toBe(3);
      expect(result.errors.some(e => e.field === 'client_id')).toBe(true);
      expect(result.errors.some(e => e.field === 'monitor_type')).toBe(true);
      expect(result.errors.some(e => e.field === 'ping_host')).toBe(true);
    });
  });

  describe('csvImportService.preview', () => {
    it('valid CSV produces preview', () => {
      const preview = csvImportService.preview(validCsv, 5);
      expect(preview.preview.length).toBe(3);
      expect(preview.wouldImport).toBe(3);
      expect(preview.wouldSkip).toBe(0);
      expect(preview.errors).toHaveLength(0);
    });

    it('preview is capped to configured number of rows', () => {
      const manyRowsCsv = `client_id,name,monitor_type,ping_host
${Array.from({ length: 20 }, (_, i) => `${1000 + i},Test ${i},prtg,`).join('\n')}`;
      const preview = csvImportService.preview(manyRowsCsv, 5);
      expect(preview.preview.length).toBe(5);
      expect(preview.wouldImport).toBe(20);
    });

    it('invalid headers rejected', () => {
      const invalidCsv = `client_id,name\n101,Test`;
      const preview = csvImportService.preview(invalidCsv, 5);
      expect(preview.wouldImport).toBe(0);
      expect(preview.errors.length).toBeGreaterThan(0);
      expect(preview.errors[0].field).toBe('_headers');
    });

    it('invalid monitor type reported', () => {
      const csv = `client_id,name,monitor_type,ping_host
101,Test,invalid,`;
      const preview = csvImportService.preview(csv, 5);
      expect(preview.wouldImport).toBe(0);
      expect(preview.errors.some(e => e.field === 'monitor_type')).toBe(true);
    });

    it('ICMP without ping_host reported', () => {
      const csv = `client_id,name,monitor_type,ping_host
101,Test,icmp,`;
      const preview = csvImportService.preview(csv, 5);
      expect(preview.wouldImport).toBe(0);
      expect(preview.errors.some(e => e.field === 'ping_host')).toBe(true);
    });

    it('duplicate inside same CSV reported', () => {
      const csv = `client_id,name,monitor_type,ping_host
101,Test 1,prtg,
101,Test 2,icmp,10.0.0.1`;
      const preview = csvImportService.preview(csv, 5);
      expect(preview.wouldImport).toBe(1);
      expect(preview.errors.some(e => e.message.includes('Duplicate'))).toBe(true);
    });

    it('existing DB client_id classified as skipped', async () => {
      customerService.create({ clientId: '101', name: 'Existing', monitorType: 'prtg', pingHost: null, enabled: true });
      const csv = `client_id,name,monitor_type,ping_host
101,Existing Duplicate,prtg,
102,New Customer,icmp,10.0.0.1`;
      const preview = csvImportService.preview(csv, 5);
      expect(preview.wouldImport).toBe(1);
      expect(preview.wouldSkip).toBe(1); // 101 is skipped (exists in DB)
    });

    it('new customer classified as importable', () => {
      const csv = `client_id,name,monitor_type,ping_host
201,New Customer,prtg,`;
      const preview = csvImportService.preview(csv, 5);
      expect(preview.wouldImport).toBe(1);
      expect(preview.wouldSkip).toBe(0);
    });

    it('large error list is capped safely', () => {
      const manyErrorsCsv = `client_id,name,monitor_type,ping_host
${Array.from({ length: 20 }, (_, i) => `,Missing ${i},prtg,`).join('\n')}`;
      const preview = csvImportService.preview(manyErrorsCsv, 5);
      expect(preview.errors.length).toBeLessThanOrEqual(10);
    });
  });

  describe('csvImportService.validateAndSummarize', () => {
    it('dry-run performs zero DB writes', async () => {
      const beforeCount = customerRepository.count();
      const { result } = csvImportService.validateAndSummarize(validCsv);
      const afterCount = customerRepository.count();
      expect(afterCount).toBe(beforeCount);
      expect(result.validCount).toBe(3);
    });

    it('reports new/duplicate/existing correctly', async () => {
      customerService.create({ clientId: '101', name: 'Existing', monitorType: 'prtg', pingHost: null, enabled: true });
      const csv = `client_id,name,monitor_type,ping_host
101,Existing Duplicate,prtg,
101,Duplicate In CSV,icmp,10.0.0.1
102,New Customer,prtg,`;
      const { result, summary } = csvImportService.validateAndSummarize(csv);
      expect(summary.totalRows).toBe(3);
      expect(summary.validCount).toBe(2);
      expect(summary.duplicateInCsv).toBe(1);
      expect(summary.existingInDb).toBe(1);
      expect(summary.newCount).toBe(1);
    });
  });
});