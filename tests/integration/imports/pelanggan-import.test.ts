import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting, getDatabase, runInTransaction } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { customerRepository } from '@/modules/customers/customer.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import { createAlertDispatcher } from '@/modules/alerts/alert.dispatcher';
import { createTelegramAlertSender } from '@/integrations/telegram/telegram-alert.sender';
import { alertRepository } from '@/modules/alerts/alert.repository';
import { createAlertingMonitoringRepository } from '@/modules/alerts/alerting-monitoring.repository';
import { MonitoringRepository } from '@/modules/monitoring/monitoring.repository';
import { createEventKey } from '@/modules/alerts/alert.policy';
import { parse } from 'csv-parse/sync';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting, getDatabase, runInTransaction } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { customerRepository } from '@/modules/customers/customer.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import { createAlertDispatcher } from '@/modules/alerts/alert.dispatcher';
import { createTelegramAlertSender } from '@/integrations/telegram/telegram-alert.sender';
import { alertRepository } from '@/modules/alerts/alert.repository';
import { createAlertingMonitoringRepository } from '@/modules/alerts/alerting-monitoring.repository';
import { MonitoringRepository } from '@/modules/monitoring/monitoring.repository';
import { runInTransaction } from '@/infrastructure/database/database';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

const adminId = '111111111';

describe('Import pelanggan.csv: real import to database', () => {
  let customerId: number;
  let transitionTime: number;

  beforeEach(() => {
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', adminId);
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    vi.stubEnv('MONITORING_ENABLED', 'true');
    vi.stubEnv('ICMP_POLL_INTERVAL_MS', '30000');
    vi.stubEnv('ALERTS_ENABLED', 'true');
    vi.stubEnv('ALERT_DISPATCH_INTERVAL_MS', '1000');
    vi.stubEnv('ALERT_MAX_EVENT_AGE_MS', '900000');
    vi.stubEnv('ALERT_MAX_ATTEMPTS', '5');
    vi.stubEnv('PRTG_POLL_INTERVAL_MS', '60000');
    vi.stubEnv('ICMP_POLL_INTERVAL_MS', '30000');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();

    customerRepository.bulkCreate([
      { clientId: 'client1', name: 'Customer One', monitorType: 'prtg', pingHost: null, enabled: true },
    ]);

    customerId = (customerRepository.findByClientId('client1'))!.id;

    groupRepository.upsert('-1001', 'Group One');
    groupRepository.assignCustomer({ groupChatId: '-1001', customerId, canView: true, receiveAlerts: true });
    groupRepository.upsert('-1001234567890', 'Global Group');
    groupRepository.assignCustomer({ groupChatId: '-1001234567890', customerId, canView: true, receiveAlerts: true });

    transitionTime = Date.now() - 5000;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('imports pelanggan.csv customers into database', async () => {
    // Read and parse the CSV
    const csvContent = await fs.promises.readFile('./pelanggan.csv', 'utf-8');
    
    const records = parse(await fs.promises.readFile('./pelanggan.csv', 'utf-8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      relax_column_count: true,
    });

    // Transform and validate
    const validCustomers = [];
    const seenClientIds = new Set();
    const clock = () => transitionTime;

for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const rowNumber = i + 1;
    const normalizedRecord = {};

    for (const [key, value] of Object.entries(record)) {
      const normalizedKey = key.trim().toLowerCase().replace(/\s+/g, '_');
      normalizedRecord[normalizedKey] = value?.trim() ?? '';
    }

    const clientId = normalizedRecord.serviceid ?? '';
    const name = normalizedRecord.nama ?? '';
    const ip = normalizedRecord.ip ?? '';
    const pingHost = ip === '-' ? null : (ip || null);

    if (!normalizedRecord.serviceid || normalizedRecord.serviceid.trim() === '') {
      continue;
    }

    if (!name) continue;
    if (seenClientIds.has(clientId)) continue;
    seenClientIds.add(clientId);

    // Check if already exists in database
    const existing = customerRepository.findByClientId(clientId);
    if (existing) {
      continue; // Skip if already exists
    }

    validCustomers.push({
      clientId: normalizedRecord.serviceid.trim(),
      name: name.trim(),
      monitorType: 'prtg',
      pingHost: ip === '-' ? null : (ip || null),
      enabled: true,
    });
    }

    // Import using the csvImportService
    const { csvImportService } = await import('@/modules/imports/csv-import.service');
    const result = await csvImportService.import(validCustomers);
    
    expect(result.imported).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    // Verify imported customers
    for (const c of validCustomers) {
      const imported = customerRepository.findByClientId(c.clientId);
      expect(imported).not.toBeNull();
      expect(imported!.name).toBe(c.name);
      expect(imported!.monitorType).toBe('prtg');
    }
  });
});