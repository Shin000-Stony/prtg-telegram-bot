import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting, getDatabase, runInTransaction } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { customerRepository } from '@/modules/customers/customer.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import { monitoringRepository } from '@/modules/monitoring/monitoring.repository';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { alertRepository } from '@/modules/alerts/alert.repository';
import { createAlertingMonitoringRepository } from '@/modules/alerts/alerting-monitoring.repository';
import { MonitoringRepository } from '@/modules/monitoring/monitoring.repository';
import { createEventKey } from '@/modules/alerts/alert.policy';

const adminId = '111111111';

describe('AlertingMonitoringRepository: real atomic rollback on outbox insert failure', () => {
  let customerId: number;
  let transitionTime: number;
  let clock: () => number;
  let db: ReturnType<typeof getDatabase>;

  beforeEach(() => {
    // Use in-memory database for isolation
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

    db = getDatabase();

    customerRepository.bulkCreate([
      { clientId: 'client1', name: 'Customer One', monitorType: 'prtg', pingHost: null, enabled: true },
    ]);

    customerId = (customerRepository.findByClientId('client1')!).id;

    groupRepository.upsert('-1001', 'Group One');
    groupRepository.assignCustomer({ groupChatId: '-1001', customerId, canView: true, receiveAlerts: true });
    groupRepository.upsert('-1001234567890', 'Global Group');
    groupRepository.assignCustomer({ groupChatId: '-1001234567890', customerId, canView: true, receiveAlerts: true });

    mappingRepository.create({ customerId, prtgObjectId: 1001, mappingMethod: 'manual', confidence: 100, verified: true });

    transitionTime = Date.now() - 5000;
    clock = () => transitionTime;

    // Seed prior state: UP, fresh observation, RECOVERY transition
    monitoringRepository.upsert({
      customerId,
      monitorType: 'prtg',
      targetFingerprint: 'prtg|true||1001',
      stableHealth: 'UP',
      latestObservation: 'UP',
      latestReason: 'recovered',
      latestRawStatus: 200,
      observedAt: transitionTime,
      lastAttemptAt: transitionTime,
      lastObservationAt: transitionTime,
      lastGoodObservationAt: null,
      consecutiveCount: 1,
      stableChangedAt: transitionTime,
      lastTransitionKind: 'RECOVERY',
      lastTransitionAt: transitionTime,
      lastProcessedGeneration: null,
      lastProcessedObservationId: null,
    });
  });

  afterEach(() => {
    try {
      // Close in-memory database to drop test triggers and reset state
      if (db) {
        db.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('real atomic rollback: outbox insert failure rolls back monitoring state, retry succeeds', async () => {
    // Snapshot prior state: UP with RECOVERY transition
    const priorState = {
      customerId,
      monitorType: 'prtg' as const,
      targetFingerprint: 'prtg|true||1001',
      stableHealth: 'UP' as const,
      latestObservation: 'UP' as const,
      latestReason: 'recovered',
      latestRawStatus: 200,
      observedAt: transitionTime - 10000,
      lastAttemptAt: transitionTime - 10000,
      lastObservationAt: transitionTime - 10000,
      lastGoodObservationAt: transitionTime - 20000,
      consecutiveCount: 1,
      stableChangedAt: transitionTime - 10000,
      lastTransitionKind: 'RECOVERY' as const,
      lastTransitionAt: transitionTime - 10000,
      lastProcessedGeneration: null,
      lastProcessedObservationId: null,
    };
    monitoringRepository.upsert(priorState);

    // Verify initial state
    const initialState = monitoringRepository.findById(customerId);
    expect(initialState).not.toBeNull();
    expect(initialState!.stableHealth).toBe('UP');
    expect(initialState!.lastTransitionKind).toBe('RECOVERY');

    // Create transition state: UP -> DOWN
    // Use transitionTime (which is clock()) for observedAt/stableChangedAt to satisfy shouldCreateEvent's freshness check
    const transitionState = {
      customerId,
      monitorType: 'prtg' as const,
      targetFingerprint: 'prtg|true||1001',
      stableHealth: 'DOWN' as const,
      latestObservation: 'DOWN' as const,
      latestReason: 'ping_failed',
      latestRawStatus: 500,
      observedAt: transitionTime,           // Use clock() time, not Date.now()
      lastAttemptAt: transitionTime,
      lastObservationAt: transitionTime,
      lastGoodObservationAt: transitionTime,
      consecutiveCount: 1,
      stableChangedAt: transitionTime,       // Use clock() time, not Date.now()
      lastTransitionKind: 'DOWN' as const,
      lastTransitionAt: transitionTime,
      lastProcessedGeneration: null,
      lastProcessedObservationId: 'obs-123',  // Required for shouldCreateEvent
    };

    // --- Step 1: Inject failure via trigger on alert_outbox insert ---
    // The trigger will fire after the monitoring state is updated, causing the transaction to abort
    const failTriggerName = 'test_outbox_failure_trigger';
    const db = getDatabase();

    // Create a trigger that fires on INSERT to alert_outbox and aborts the transaction
    db.exec(`
      CREATE TRIGGER ${failTriggerName}
      AFTER INSERT ON alert_outbox
      BEGIN
        SELECT RAISE(ABORT, 'synthetic_outbox_failure');
      END;
    `);

    // Verify trigger was created
    const triggerCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(failTriggerName);
    expect(triggerCheck).not.toBeNull();

    // --- Step 2: Call upsertBatch with the DOWN transition ---
    // This should:
    // 1. Update monitoring state to DOWN
    // 2. Attempt to insert outbox rows
    // 3. Trigger fires and aborts the transaction
    let threw = false;
    try {
      const alertingRepo = createAlertingMonitoringRepository(new (await import('@/modules/monitoring/monitoring.repository')).MonitoringRepository(), {
        clock: () => transitionTime,
        prtgPollIntervalMs: 60000,
        icmpPollIntervalMs: 30000,
        maxEventAgeMs: 900000,
        enabled: true,
        globalChatId: '-1001234567890',
      });

      // Assert db.inTransaction === false before operation
      expect(db.inTransaction).toBe(false);

      await alertingRepo.upsertBatch([{
        customerId,
        monitorType: 'prtg' as const,
        targetFingerprint: 'prtg|true||1001',
        stableHealth: 'DOWN' as const,
        latestObservation: 'DOWN' as const,
        latestReason: 'ping_failed',
        latestRawStatus: 500,
        observedAt: transitionTime,
        lastAttemptAt: transitionTime,
        lastObservationAt: transitionTime,
        lastGoodObservationAt: transitionTime,
        consecutiveCount: 1,
        stableChangedAt: transitionTime,
        lastTransitionKind: 'DOWN' as const,
        lastTransitionAt: transitionTime,
        lastProcessedGeneration: null,
        lastProcessedObservationId: 'obs-123',  // Required for shouldCreateEvent
      }]);
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain('synthetic_outbox_failure');
    }
    expect(threw).toBe(true);

    // Assert db.inTransaction === false after failure
    expect(db.inTransaction).toBe(false);

    // Assert no partial outbox rows committed
    const downEventKey = createEventKey(customerId, 'prtg|true||1001', 'DOWN', 'obs-123');
    const outboxAfterFailure = alertRepository.findByEventKey(downEventKey);
    expect(outboxAfterFailure.length).toBe(0);

    // Assert db.inTransaction === false after failure (still false after rollback)
    expect(db.inTransaction).toBe(false);

    // Assert state after failure equals initial state (including observation identity)
    const stateAfterFailure = monitoringRepository.findById(customerId);
    expect(stateAfterFailure).not.toBeNull();
    expect(stateAfterFailure).toEqual(initialState);

    // --- Step 4: Remove trigger and retry ---
    db.exec(`DROP TRIGGER ${failTriggerName};`);

    // Assert db.inTransaction === false before retry
    expect(db.inTransaction).toBe(false);

    // Retry the same operation
    const alertingRepoRetry = createAlertingMonitoringRepository(new (await import('@/modules/monitoring/monitoring.repository')).MonitoringRepository(), {
      clock: () => transitionTime,
      prtgPollIntervalMs: 60000,
      icmpPollIntervalMs: 30000,
      maxEventAgeMs: 900000,
      enabled: true,
      globalChatId: '-1001234567890',
    });

    await alertingRepoRetry.upsertBatch([{
      customerId,
      monitorType: 'prtg' as const,
      targetFingerprint: 'prtg|true||1001',
      stableHealth: 'DOWN' as const,
      latestObservation: 'DOWN' as const,
      latestReason: 'ping_failed',
      latestRawStatus: 500,
      observedAt: transitionTime,
      lastAttemptAt: transitionTime,
      lastObservationAt: transitionTime,
      lastGoodObservationAt: transitionTime,
      consecutiveCount: 1,
      stableChangedAt: transitionTime,
      lastTransitionKind: 'DOWN' as const,
      lastTransitionAt: transitionTime,
      lastProcessedGeneration: null,
      lastProcessedObservationId: 'obs-123',
    }]);

    // Assert db.inTransaction === false after successful retry
    expect(db.inTransaction).toBe(false);

    // --- Step 5: Verify retry succeeded ---
    const stateAfterRetry = monitoringRepository.findById(customerId);
    expect(stateAfterRetry).not.toBeNull();
    expect(stateAfterRetry!.stableHealth).toBe('DOWN');
    expect(stateAfterRetry!.stableChangedAt).toBeGreaterThan(priorState.stableChangedAt);
    expect(stateAfterRetry!.lastTransitionKind).toBe('DOWN');
    // Assert observation identity matches input
    expect(stateAfterRetry!.observedAt).toBe(transitionState.observedAt);
    expect(stateAfterRetry!.lastObservationAt).toBe(transitionState.lastObservationAt);
    expect(stateAfterRetry!.stableChangedAt).toBe(transitionState.stableChangedAt);
    expect(stateAfterRetry!.lastTransitionKind).toBe(transitionState.lastTransitionKind);
    // Assert lastProcessedObservationId and lastProcessedGeneration match input
    expect(stateAfterRetry!.lastProcessedObservationId).toBe('obs-123');
    expect(stateAfterRetry!.lastProcessedGeneration).toBe(transitionState.lastProcessedGeneration);

    // Assert exactly two recipients: -1001 and -1001234567890, order independent, both pending
    // downEventKey already declared above
    const outboxAfterRetry = alertRepository.findByEventKey(downEventKey);
    expect(outboxAfterRetry.length).toBe(2);
    const recipientChatIds = outboxAfterRetry.map(r => r.groupChatId).sort();
    expect(recipientChatIds).toEqual(['-1001', '-1001234567890']);
    expect(outboxAfterRetry.every(r => r.status === 'pending')).toBe(true);
  });
});