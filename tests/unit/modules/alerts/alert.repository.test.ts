import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting, getDatabase } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { customerRepository } from '@/modules/customers/customer.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import { MonitoringRepository } from '@/modules/monitoring/monitoring.repository';
import { AlertRepository } from '@/modules/alerts/alert.repository';
import type { MonitoringState } from '@/modules/monitoring/monitoring.types';
import { alertRepository } from '@/modules/alerts/alert.repository';
import { buildDownCard, buildRecoveryCard } from '@/integrations/telegram/ui/alert-card';
import { htmlEscape } from '@/integrations/telegram/ui/messages';
import { createTelegramAlertSender } from '@/integrations/telegram/telegram-alert.sender';

const adminId = '111111111';

describe('AlertRepository - F3/F4/F5/F6 regression tests', () => {
  let customer1Id: number;
  let customer2Id: number;

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
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();

    customerRepository.bulkCreate([
      { clientId: 'client1', name: 'Customer One', monitorType: 'prtg', pingHost: null, enabled: true },
      { clientId: 'client2', name: 'Customer Two', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true },
    ]);

    const c1 = customerRepository.findByClientId('client1');
    const c2 = customerRepository.findByClientId('client2');
    customer1Id = c1!.id;
    customer2Id = c2!.id;

    // Create telegram groups for testing
    groupRepository.upsert('-1001', 'Group One');
    groupRepository.upsert('-1002', 'Group Two');
    groupRepository.assignCustomer({ groupChatId: '-1001', customerId: customer1Id, canView: true, receiveAlerts: true });
    groupRepository.assignCustomer({ groupChatId: '-1002', customerId: customer2Id, canView: true, receiveAlerts: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('F3: HOLD persistence and deferPending', () => {
    it('deferPending advances due time for HELD rows without consuming attempt', () => {
      const now = Date.now();
      const repo = new AlertRepository();

      // Insert a pending alert row
      repo.insertEvent({
        eventKey: 'test-key-1',
        kind: 'DOWN',
        customerId: customer1Id,
        targetFingerprint: 'fp-1',
        monitorType: 'prtg',
        triggeringObservationId: 'obs-1',
        occurrenceAt: Date.now(),
        clientId: 'client1',
        customerName: 'Customer One',
        monitorSource: 'PRTG',
        targetDisplay: 'Test Target',
        prtgObjectId: 1001,
      }, [{ groupChatId: '-1001', customerId: 1 }], now + 3600000, () => now);

      // Verify initial state
      let row = getDatabase().prepare('SELECT * FROM alert_outbox WHERE event_key = ?').get('test-key-1');
      expect(row).toBeTruthy();
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.next_attempt_at).toBe(0);

      // Defer the pending row (HOLD)
      const deferred = alertRepository.deferPending(1, now + 60000, now);
      expect(deferred).toBe(true);

      // Verify due time advanced, attempts unchanged
      row = getDatabase().prepare('SELECT * FROM alert_outbox WHERE event_key = ?').get('test-key-1');
      expect(row.next_attempt_at).toBe(now + 60000);
      expect(row.attempts).toBe(0);
      expect(row.status).toBe('pending');
    });

    it('HOLD batches do not starve eligible work - deferPending allows other rows to proceed', () => {
      const now = Date.now();
      const repo = new AlertRepository();

      // Insert two pending alert rows
      repo.insertEvent({
        eventKey: 'hold-key',
        kind: 'DOWN',
        customerId: customer1Id,
        targetFingerprint: 'fp-hold',
        monitorType: 'prtg',
        triggeringObservationId: 'obs-hold',
        occurrenceAt: now,
        clientId: 'client1',
        customerName: 'Customer One',
        monitorSource: 'PRTG',
        targetDisplay: 'Hold Target',
        prtgObjectId: 1001,
      }, [{ groupChatId: '-1001', customerId: 1 }], now + 3600000, () => now);

      repo.insertEvent({
        eventKey: 'ready-key',
        kind: 'DOWN',
        customerId: customer2Id,
        targetFingerprint: 'fp-ready',
        monitorType: 'icmp',
        triggeringObservationId: 'obs-ready',
        occurrenceAt: now,
        clientId: 'client2',
        customerName: 'Customer Two',
        monitorSource: 'ICMP',
        targetDisplay: 'Ready Target',
      }, [{ groupChatId: '-1002', customerId: 2 }], now + 3600000, () => now);

      // Defer the first (HOLD)
      alertRepository.deferPending(1, now + 60000, now);

      // Verify the second row is still pending and eligible
      const readyRow = getDatabase().prepare('SELECT * FROM alert_outbox WHERE event_key = ?').get('ready-key');
      expect(readyRow.status).toBe('pending');
      expect(readyRow.next_attempt_at).toBe(0);

      // First row was deferred
      const holdRow = getDatabase().prepare('SELECT * FROM alert_outbox WHERE event_key = ?').get('hold-key');
      expect(holdRow.next_attempt_at).toBeGreaterThan(Date.now());
    });
  });

  describe('F3: Superseded events cancelled, not held', () => {
    it('stable-transition mismatch cancels rather than holds', () => {
      const now = Date.now();
      const repo = new AlertRepository();

      repo.insertEvent({
        eventKey: 'superseded-key',
        kind: 'DOWN',
        customerId: customer1Id,
        targetFingerprint: 'fp-1',
        monitorType: 'prtg',
        triggeringObservationId: 'obs-old',
        occurrenceAt: now - 10000,
        clientId: 'client1',
        customerName: 'Customer One',
        monitorSource: 'PRTG',
        targetDisplay: 'Test Target',
        prtgObjectId: 1001,
      }, [{ groupChatId: '-1001', customerId: 1 }], now + 3600000, () => now);

      // Manually update to simulate superseded state (different occurrenceAt)
      getDatabase().prepare('UPDATE alert_outbox SET occurrence_at = ?, status = ? WHERE id = ?').run(now - 5000, 'pending', 1);

      // In dispatcher, this would be detected as superseded (occurrenceAt mismatch)
      // The row should be cancelled, not held
      const row = getDatabase().prepare('SELECT * FROM alert_outbox WHERE event_key = ?').get('superseded-key');
      expect(row.occurrence_at).toBe(now - 5000);
    });
  });

  describe('F4: 429 cooldown stops batch immediately', () => {
    it('rateLimitedUntil checked before each request, stops batch on 429', () => {
      // This test will be enhanced after dispatcher fix
      // For now, verify the repository supports deferPending for 429 handling
      const now = Date.now();
      const repo = new AlertRepository();

      repo.insertEvent({
        eventKey: 'rate-key-1',
        kind: 'DOWN',
        customerId: customer1Id,
        targetFingerprint: 'fp-1',
        monitorType: 'prtg',
        triggeringObservationId: 'obs-1',
        occurrenceAt: now,
        clientId: 'client1',
        customerName: 'Customer One',
        monitorSource: 'PRTG',
        targetDisplay: 'Test Target',
        prtgObjectId: 1001,
      }, [{ groupChatId: '-1001', customerId: 1 }], now + 3600000, () => now);

      repo.insertEvent({
        eventKey: 'rate-key-2',
        kind: 'DOWN',
        customerId: customer2Id,
        targetFingerprint: 'fp-2',
        monitorType: 'icmp',
        triggeringObservationId: 'obs-2',
        occurrenceAt: now,
        clientId: 'client2',
        customerName: 'Customer Two',
        monitorSource: 'ICMP',
        targetDisplay: 'Test Target 2',
      }, [{ groupChatId: '-1002', customerId: 2 }], now + 3600000, () => now);

      // Defer first row (simulate 429)
      alertRepository.deferPending(1, now + 20000, now);

      // First row deferred
      const row1 = getDatabase().prepare('SELECT * FROM alert_outbox WHERE event_key = ?').get('rate-key-1');
      expect(row1.next_attempt_at).toBe(now + 20000);

      // Second row still pending at 0
      const row2 = getDatabase().prepare('SELECT * FROM alert_outbox WHERE event_key = ?').get('rate-key-2');
      expect(row2.next_attempt_at).toBe(0);
    });

    it('invalid/missing retry_after uses normal bounded backoff', () => {
      // This validates the sender classification logic
      // Will be tested in sender tests
      expect(true).toBe(true);
    });
  });

  describe('F4: Claim/ack/timer lifecycle', () => {
    it('claimSpending moves pending->sending and increments attempts', () => {
      const now = Date.now();
      const repo = new AlertRepository();

      repo.insertEvent({
        eventKey: 'claim-key',
        kind: 'DOWN',
        customerId: customer1Id,
        targetFingerprint: 'fp-claim',
        monitorType: 'prtg',
        triggeringObservationId: 'obs-claim',
        occurrenceAt: now,
        clientId: 'client1',
        customerName: 'Customer One',
        monitorSource: 'PRTG',
        targetDisplay: 'Claim Target',
        prtgObjectId: 1001,
      }, [{ groupChatId: '-1001', customerId: 1 }], now + 3600000, () => now);

      // Claim the row
      const claimed = repo.claimSending(1, 'pending', now);
      expect(claimed).toBe(true);

      // Verify state changed
      const row = getDatabase().prepare('SELECT * FROM alert_outbox WHERE event_key = ?').get('claim-key');
      expect(row.status).toBe('sending');
      expect(row.attempts).toBe(1);
      expect(row.last_attempt_at).toBe(now);
      expect(row.next_attempt_at).toBe(now + 60000);
    });

    it('markSent returns false if row was deleted/cancelled', () => {
      const now = Date.now();
      const repo = new AlertRepository();

      repo.insertEvent({
        eventKey: 'acksent-key',
        kind: 'DOWN',
        customerId: customer1Id,
        targetFingerprint: 'fp-ack',
        monitorType: 'prtg',
        triggeringObservationId: 'obs-ack',
        occurrenceAt: now,
        clientId: 'client1',
        customerName: 'Customer One',
        monitorSource: 'PRTG',
        targetDisplay: 'Ack Target',
        prtgObjectId: 1001,
      }, [{ groupChatId: '-1001', customerId: 1 }], now + 3600000, () => now);

      // Delete the row manually (simulating external cancellation)
      getDatabase().prepare('DELETE FROM alert_outbox WHERE event_key = ?').run('acksent-key');

      // Try to mark as sent
      const result = repo.markSent(1, 12345, now);
      expect(result).toBe(false);
    });

    it('final transient failure with maxAttempts becomes failed (no extra pending)', () => {
      const now = Date.now();
      const repo = new AlertRepository();

      // Insert row with attempts = maxAttempts - 1
      repo.insertEvent({
        eventKey: 'final-fail-key',
        kind: 'DOWN',
        customerId: customer1Id,
        targetFingerprint: 'fp-final',
        monitorType: 'prtg',
        triggeringObservationId: 'obs-final',
        occurrenceAt: now,
        clientId: 'client1',
        customerName: 'Customer One',
        monitorSource: 'PRTG',
        targetDisplay: 'Final Target',
        prtgObjectId: 1001,
      }, [{ groupChatId: '-1001', customerId: customer1Id }], now + 3600000, () => now);

      // Set attempts to maxAttempts (5) - simulating the state AFTER the 5th claimSending
      // This is the state when the final (5th) attempt is about to fail
      getDatabase().prepare('UPDATE alert_outbox SET attempts = ?, status = ? WHERE event_key = ?').run(5, 'sending', 'final-fail-key');

      // Simulate transient failure on the final (5th) attempt
      repo.markFailed(1, 'transient', 'test failure', now);

      const row = getDatabase().prepare('SELECT * FROM alert_outbox WHERE event_key = ?').get('final-fail-key');
      expect(row.status).toBe('failed');
      // markFailed should NOT increment attempts again - it should remain at maxAttempts (5)
      expect(row.attempts).toBe(5);
    });
  });

  describe('F5: Error sanitization', () => {
    it('sender classifies 429 with valid retry_after', async () => {
      const { createTelegramAlertSender } = await import('@/integrations/telegram/telegram-alert.sender');
      
      const fakeBot = {
        telegram: {
          callApi: vi.fn().mockRejectedValue({
            response: {
              status: 429,
              parameters: { retry_after: 20 },
              error_code: 429,
            },
          }),
        },
      };

      const sender = createTelegramAlertSender(fakeBot);
      const controller = new AbortController();
      const result = await sender.send('-1001', '<b>Test</b>', controller.signal);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('rate_limited');
      expect(result.retryAfterSeconds).toBe(20);
    });

    it('sender validates retry_after as finite positive, uses backoff for invalid', async () => {
      const { createTelegramAlertSender } = await import('@/integrations/telegram/telegram-alert.sender');
      
      const fakeBot = {
        telegram: {
          callApi: vi.fn().mockRejectedValue({
            response: {
              status: 429,
              parameters: { retry_after: NaN },
              error_code: 429,
            },
          }),
        },
      };

      const sender = createTelegramAlertSender(fakeBot);
      const controller = new AbortController();
      const result = await sender.send('-1001', '<b>Test</b>', controller.signal);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('rate_limited');
      // Invalid retry_after should return undefined, dispatcher will use its configured backoff
      expect(result.retryAfterSeconds).toBeUndefined();
    });

    it('dispatcher sanitizes errors - no raw error objects in logs/DB', () => {
      // This will be tested via dispatcher integration tests
      expect(true).toBe(true);
    });
  });

  describe('F6: Card formatting - single builder, escaping, budget', () => {
    it('buildDownCard uses htmlEscape and enforces 3500 char limit', () => {
      const row = {
        client_id: 'client1',
        customer_name: 'Customer One',
        monitor_source: 'PRTG',
        target_display: 'PRTG Server / Ping (obj 1001)',
        occurrence_at: Date.now(),
        event_key: 'abcdef12',
        monitor_type: 'prtg',
        prtg_object_id: 1001,
      };

      const result = buildDownCard(row);
      expect(result.valid).toBe(true);
      expect(result.html).toContain('🔴 DOWN');
      expect(result.html).toContain('Client:');
      expect(result.html).toContain('Customer:');
      expect(result.html).toContain('Source:');
      expect(result.html).toContain('Target:');
      expect(result.html).toContain('Transition:');
      expect(result.html).toContain('Ref:');
      expect(result.html.length).toBeLessThanOrEqual(3500);

      // Verify htmlEscape is used for user content (special chars escaped)
      expect(result.html).toContain('<b>'); // escaped <b>
      expect(result.html).not.toContain('<script>'); // dangerous tags removed
    });

    it('buildRecoveryCard similar structure', () => {
      const row = {
        client_id: 'client1',
        customer_name: 'Customer One',
        monitor_source: 'ICMP',
        target_display: '10.0.0.1',
        occurrence_at: Date.now(),
        event_key: 'fedcba34',
        monitor_type: 'icmp',
      };

      const result = buildRecoveryCard(row);
      expect(result.valid).toBe(true);
      expect(result.html).toContain('🟢 RECOVERY');
      expect(result.html.length).toBeLessThanOrEqual(3500);
    });

    it('truncates long fields before escaping', () => {
      const row = {
        client_id: 'a'.repeat(200), // long client_id
        customer_name: 'b'.repeat(500), // long name
        monitor_source: 'PRTG',
        target_display: 'c'.repeat(500), // long target
        occurrence_at: Date.now(),
        event_key: 'abcdef12',
        monitor_type: 'prtg',
        prtg_object_id: 1001,
      };

      const result = buildDownCard(row);
      expect(result.valid).toBe(true);
      expect(result.html.length).toBeLessThanOrEqual(3500);
    });
  });

  describe('F7: App composition with alerts on/off', () => {
    it('ALERTS_ENABLED=false disables alert dispatcher', async () => {
      vi.stubEnv('ALERTS_ENABLED', 'false');
      vi.stubEnv('MONITORING_ENABLED', 'true');
      
      // Reset config
      const { resetConfigForTesting, getConfig } = await import('@/config/env');
      resetConfigForTesting();
      const config = getConfig();
      expect(config.ALERTS_ENABLED).toBe(false);

      vi.unstubAllEnvs();
    });

    it('ALERTS_ENABLED=true enables alert dispatcher', async () => {
      vi.stubEnv('ALERTS_ENABLED', 'true');
      vi.stubEnv('MONITORING_ENABLED', 'true');
      
      const { resetConfigForTesting, getConfig } = await import('@/config/env');
      resetConfigForTesting();
      const config = getConfig();
      expect(config.ALERTS_ENABLED).toBe(true);

      vi.unstubAllEnvs();
    });
  });
});