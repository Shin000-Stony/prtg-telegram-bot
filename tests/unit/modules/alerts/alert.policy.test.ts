import { describe, it, expect } from 'vitest';
import { shouldCreateEvent, createEventKey, determineTargetFingerprint } from '@/modules/alerts/alert.policy';
import { fingerprintToString } from '@/modules/monitoring/monitoring.reducer';
import type { MonitoringState } from '@/modules/monitoring/monitoring.types';

const ICMP_FP = fingerprintToString('icmp', true, '10.0.0.1', null);
const clock = () => 10000;
const PRTG_INTERVAL = 60000;
const ICMP_INTERVAL = 30000;
const OBSERVED_AT = 5000;

function makePrevIcmp(overrides: Partial<MonitoringState> = {}): MonitoringState {
  return {
    customerId: 1,
    monitorType: 'icmp',
    targetFingerprint: ICMP_FP,
    stableHealth: 'UNKNOWN',
    latestObservation: 'UNKNOWN',
    latestReason: 'unknown',
    latestRawStatus: null,
    observedAt: null,
    lastAttemptAt: null,
    lastObservationAt: null,
    lastGoodObservationAt: null,
    consecutiveCount: 0,
    stableChangedAt: null,
    lastTransitionKind: null,
    lastTransitionAt: null,
    lastProcessedGeneration: null,
    lastProcessedObservationId: null,
    ...overrides,
  };
}

function makeCustomerIcmp(overrides: Partial<{
  id: number; clientId: string; name: string; monitorType: string; pingHost: string | null; enabled: boolean;
}> = {}) {
  return {
    id: 1,
    clientId: 'icmp1',
    name: 'ICMP Customer',
    monitorType: 'icmp',
    pingHost: '10.0.0.1',
    enabled: true,
    ...overrides,
  };
}

describe('shouldCreateEvent - ICMP', () => {
  describe('DOWN transition', () => {
    it('UP→DOWN stabilizes creates DOWN alert event', () => {
      const prevState = makePrevIcmp({
        stableHealth: 'UP',
        latestObservation: 'UP',
        latestReason: 'reply_received',
        latestRawStatus: 15,
        observedAt: OBSERVED_AT,
        lastAttemptAt: OBSERVED_AT,
        lastObservationAt: OBSERVED_AT,
        lastGoodObservationAt: OBSERVED_AT,
        consecutiveCount: 2,
        stableChangedAt: OBSERVED_AT,
        lastTransitionKind: null,
        lastTransitionAt: null,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|5000',
        lastProcessedGeneration: 1,
      });

      const nextState = makePrevIcmp({
        stableHealth: 'DOWN',
        latestObservation: 'DOWN',
        latestReason: 'no_reply',
        latestRawStatus: null,
        observedAt: OBSERVED_AT + 1000,
        lastAttemptAt: OBSERVED_AT + 1000,
        lastObservationAt: OBSERVED_AT + 1000,
        lastGoodObservationAt: OBSERVED_AT,
        consecutiveCount: 2,
        stableChangedAt: OBSERVED_AT + 1000,
        lastTransitionKind: 'DOWN',
        lastTransitionAt: OBSERVED_AT + 1000,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|6000',
        lastProcessedGeneration: 1,
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp(),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).not.toBeNull();
      expect(result.event!.kind).toBe('DOWN');
      expect(result.event!.monitorType).toBe('icmp');
      expect(result.event!.targetFingerprint).toBe(ICMP_FP);
      expect(result.event!.triggeringObservationId).toBe('icmp|1|10.0.0.1|6000');
      expect(result.event!.monitorSource).toBe('ICMP');
      expect(result.event!.targetDisplay).toBe('ICMP 10.0.0.1');
    });
  });

  describe('RECOVERY transition', () => {
    it('DOWN→UP stabilizes creates RECOVERY alert event', () => {
      const prevState = makePrevIcmp({
        stableHealth: 'DOWN',
        latestObservation: 'DOWN',
        latestReason: 'no_reply',
        latestRawStatus: null,
        observedAt: OBSERVED_AT,
        lastAttemptAt: OBSERVED_AT,
        lastObservationAt: OBSERVED_AT,
        consecutiveCount: 2,
        stableChangedAt: OBSERVED_AT,
        lastTransitionKind: 'DOWN',
        lastTransitionAt: OBSERVED_AT,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|5000',
        lastProcessedGeneration: 1,
      });

      const nextState = makePrevIcmp({
        stableHealth: 'UP',
        latestObservation: 'UP',
        latestReason: 'reply_received',
        latestRawStatus: 12,
        observedAt: OBSERVED_AT + 1000,
        lastAttemptAt: OBSERVED_AT + 1000,
        lastObservationAt: OBSERVED_AT + 1000,
        lastGoodObservationAt: OBSERVED_AT + 1000,
        consecutiveCount: 2,
        stableChangedAt: OBSERVED_AT + 1000,
        lastTransitionKind: 'RECOVERY',
        lastTransitionAt: OBSERVED_AT + 1000,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|6000',
        lastProcessedGeneration: 1,
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp(),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).not.toBeNull();
      expect(result.event!.kind).toBe('RECOVERY');
      expect(result.event!.monitorType).toBe('icmp');
    });
  });

  describe('UNKNOWN does not create alerts', () => {
    it('UNKNOWN stable health never produces DOWN event', () => {
      const prevState = makePrevIcmp({
        stableHealth: 'UP',
        latestObservation: 'UP',
        observedAt: OBSERVED_AT,
        stableChangedAt: OBSERVED_AT,
        consecutiveCount: 2,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|5000',
      });

      const nextState = makePrevIcmp({
        stableHealth: 'UNKNOWN',
        latestObservation: 'UNKNOWN',
        latestReason: 'timeout',
        observedAt: OBSERVED_AT + 1000,
        lastAttemptAt: OBSERVED_AT + 1000,
        lastObservationAt: OBSERVED_AT + 1000,
        stableChangedAt: null,
        consecutiveCount: 0,
        lastTransitionKind: null,
        lastTransitionAt: null,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|6000',
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp(),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).toBeNull();
      expect(result.diagnostic).toBe('stable health UNKNOWN');
    });

    it('prevState UNKNOWN does not produce event', () => {
      const prevState = makePrevIcmp({
        stableHealth: 'UNKNOWN',
        latestObservation: 'UNKNOWN',
        observedAt: OBSERVED_AT,
        consecutiveCount: 1,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|5000',
      });

      const nextState = makePrevIcmp({
        stableHealth: 'DOWN',
        latestObservation: 'DOWN',
        latestReason: 'no_reply',
        observedAt: OBSERVED_AT + 1000,
        lastAttemptAt: OBSERVED_AT + 1000,
        lastObservationAt: OBSERVED_AT + 1000,
        stableChangedAt: OBSERVED_AT + 1000,
        consecutiveCount: 2,
        lastTransitionKind: null,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|6000',
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp(),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).toBeNull();
    });

    it('no previous state is silent baseline (no event)', () => {
      const nextState = makePrevIcmp({
        stableHealth: 'DOWN',
        latestObservation: 'DOWN',
        latestReason: 'no_reply',
        observedAt: OBSERVED_AT,
        lastAttemptAt: OBSERVED_AT,
        lastObservationAt: OBSERVED_AT,
        stableChangedAt: OBSERVED_AT,
        consecutiveCount: 2,
        lastTransitionKind: null,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|5000',
      });

      const result = shouldCreateEvent({
        prevState: null,
        nextState,
        customer: makeCustomerIcmp(),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).toBeNull();
      expect(result.diagnostic).toBe('no previous state (silent baseline)');
    });
  });

  describe('local probe failure does not create false alerts', () => {
    it('local probe failure (UNKNOWN) between UP observations does not create DOWN event', () => {
      const prevState = makePrevIcmp({
        stableHealth: 'UP',
        latestObservation: 'UP',
        latestReason: 'reply_received',
        observedAt: OBSERVED_AT,
        stableChangedAt: OBSERVED_AT,
        consecutiveCount: 2,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|5000',
      });

      const nextState = makePrevIcmp({
        stableHealth: 'UP',
        latestObservation: 'UNKNOWN',
        latestReason: 'timeout',
        observedAt: OBSERVED_AT + 1000,
        lastAttemptAt: OBSERVED_AT + 1000,
        lastObservationAt: OBSERVED_AT + 1000,
        stableChangedAt: OBSERVED_AT,
        consecutiveCount: 0,
        lastTransitionKind: null,
        lastTransitionAt: null,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|6000',
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp(),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).toBeNull();
      expect(result.diagnostic).toBe('no stable transition');
    });

    it('UNKNOWN observation between DOWN states does not create RECOVERY event', () => {
      const prevState = makePrevIcmp({
        stableHealth: 'DOWN',
        latestObservation: 'DOWN',
        observedAt: OBSERVED_AT,
        stableChangedAt: OBSERVED_AT,
        consecutiveCount: 2,
        lastTransitionKind: 'DOWN',
        lastProcessedObservationId: 'icmp|1|10.0.0.1|5000',
      });

      const nextState = makePrevIcmp({
        stableHealth: 'DOWN',
        latestObservation: 'UNKNOWN',
        latestReason: 'timeout',
        observedAt: OBSERVED_AT + 1000,
        lastAttemptAt: OBSERVED_AT + 1000,
        lastObservationAt: OBSERVED_AT + 1000,
        stableChangedAt: OBSERVED_AT,
        consecutiveCount: 0,
        lastTransitionKind: 'DOWN',
        lastTransitionAt: OBSERVED_AT,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|6000',
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp(),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).toBeNull();
      expect(result.diagnostic).toBe('no stable transition');
    });

    it('inconsistent stable health change with mismatched latestObservation is rejected', () => {
      const prevState = makePrevIcmp({
        stableHealth: 'UP',
        latestObservation: 'UP',
        observedAt: OBSERVED_AT,
        stableChangedAt: OBSERVED_AT,
        consecutiveCount: 2,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|5000',
      });

      const nextState = makePrevIcmp({
        stableHealth: 'DOWN',
        latestObservation: 'UNKNOWN',
        latestReason: 'timeout',
        observedAt: OBSERVED_AT + 1000,
        lastAttemptAt: OBSERVED_AT + 1000,
        lastObservationAt: OBSERVED_AT + 1000,
        stableChangedAt: OBSERVED_AT + 1000,
        consecutiveCount: 0,
        lastTransitionKind: 'DOWN',
        lastProcessedObservationId: 'icmp|1|10.0.0.1|6000',
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp(),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).toBeNull();
      expect(result.diagnostic).toBe('latest observation does not match stable health');
    });
  });

  describe('stale observation rejection', () => {
    it('observedAt beyond twice the poll interval is rejected', () => {
      const prevState = makePrevIcmp({
        stableHealth: 'UP',
        latestObservation: 'UP',
        observedAt: 1000,
        stableChangedAt: 1000,
        consecutiveCount: 2,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|1000',
      });

      const nextState = makePrevIcmp({
        stableHealth: 'DOWN',
        latestObservation: 'DOWN',
        latestReason: 'no_reply',
        observedAt: 1000,
        lastAttemptAt: 1000,
        lastObservationAt: 1000,
        stableChangedAt: 1000,
        consecutiveCount: 2,
        lastTransitionKind: 'DOWN',
        lastTransitionAt: 1000,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|2000',
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp(),
        mapping: null,
        clock: () => 100000,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).toBeNull();
      expect(result.diagnostic).toBe('observedAt stale beyond poll interval');
    });
  });

  describe('fingerprint mismatch', () => {
    it('target fingerprint mismatch prevents event', () => {
      const prevState = makePrevIcmp({
        targetFingerprint: 'icmp|true|10.0.0.1|',
        stableHealth: 'UP',
        latestObservation: 'UP',
        observedAt: OBSERVED_AT,
        stableChangedAt: OBSERVED_AT,
        consecutiveCount: 2,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|5000',
      });

      const nextState = makePrevIcmp({
        targetFingerprint: 'icmp|true|10.0.0.2|',
        stableHealth: 'DOWN',
        latestObservation: 'DOWN',
        observedAt: OBSERVED_AT + 1000,
        stableChangedAt: OBSERVED_AT + 1000,
        consecutiveCount: 2,
        lastTransitionKind: 'DOWN',
        lastProcessedObservationId: 'icmp|1|10.0.0.2|6000',
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp(),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).toBeNull();
    });

    it('target fingerprint matches current config', () => {
      const prevState = makePrevIcmp({
        stableHealth: 'UP',
        latestObservation: 'UP',
        observedAt: OBSERVED_AT,
        stableChangedAt: OBSERVED_AT,
        consecutiveCount: 2,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|5000',
      });

      const nextState = makePrevIcmp({
        stableHealth: 'DOWN',
        latestObservation: 'DOWN',
        observedAt: OBSERVED_AT + 1000,
        stableChangedAt: OBSERVED_AT + 1000,
        consecutiveCount: 2,
        lastTransitionKind: 'DOWN',
        lastProcessedObservationId: 'icmp|1|10.0.0.1|6000',
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp(),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).not.toBeNull();
      const expectedFP = determineTargetFingerprint('icmp', true, '10.0.0.1', null);
      expect(result.event!.targetFingerprint).toBe(expectedFP);
    });
  });

  describe('disabled customer', () => {
    it('disabled customer does not create event', () => {
      const prevState = makePrevIcmp({
        stableHealth: 'UP',
        latestObservation: 'UP',
        observedAt: OBSERVED_AT,
        stableChangedAt: OBSERVED_AT,
        consecutiveCount: 2,
        lastProcessedObservationId: 'icmp|1|10.0.0.1|5000',
      });

      const nextState = makePrevIcmp({
        stableHealth: 'DOWN',
        latestObservation: 'DOWN',
        observedAt: OBSERVED_AT + 1000,
        stableChangedAt: OBSERVED_AT + 1000,
        consecutiveCount: 2,
        lastTransitionKind: 'DOWN',
        lastProcessedObservationId: 'icmp|1|10.0.0.1|6000',
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp({ enabled: false }),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).toBeNull();
      expect(result.diagnostic).toBe('customer disabled');
    });
  });

  describe('missing pingHost for ICMP', () => {
    it('ICMP customer without pingHost does not create event', () => {
      const prevState = makePrevIcmp({
        targetFingerprint: fingerprintToString('icmp', true, null, null),
        stableHealth: 'UP',
        latestObservation: 'UP',
        observedAt: OBSERVED_AT,
        stableChangedAt: OBSERVED_AT,
        consecutiveCount: 2,
        lastProcessedObservationId: 'icmp|1|null|5000',
      });

      const nextState = makePrevIcmp({
        targetFingerprint: fingerprintToString('icmp', true, null, null),
        stableHealth: 'DOWN',
        latestObservation: 'DOWN',
        observedAt: OBSERVED_AT + 1000,
        stableChangedAt: OBSERVED_AT + 1000,
        consecutiveCount: 2,
        lastTransitionKind: 'DOWN',
        lastProcessedObservationId: 'icmp|1|null|6000',
      });

      const result = shouldCreateEvent({
        prevState,
        nextState,
        customer: makeCustomerIcmp({ pingHost: null }),
        mapping: null,
        clock,
        prtgPollIntervalMs: PRTG_INTERVAL,
        icmpPollIntervalMs: ICMP_INTERVAL,
      });

      expect(result.event).toBeNull();
      expect(result.diagnostic).toBe('ICMP pingHost missing');
    });
  });

  describe('eventKey dedup', () => {
    it('same inputs produce same eventKey', () => {
      const key1 = createEventKey(1, ICMP_FP, 'DOWN', 'icmp|1|10.0.0.1|6000');
      const key2 = createEventKey(1, ICMP_FP, 'DOWN', 'icmp|1|10.0.0.1|6000');
      expect(key1).toBe(key2);
    });

    it('different inputs produce different eventKey', () => {
      const key1 = createEventKey(1, ICMP_FP, 'DOWN', 'icmp|1|10.0.0.1|6000');
      const key2 = createEventKey(1, ICMP_FP, 'DOWN', 'icmp|1|10.0.0.1|7000');
      expect(key1).not.toBe(key2);
    });

    it('down vs recovery with same observation produce different keys', () => {
      const downKey = createEventKey(1, ICMP_FP, 'DOWN', 'icmp|1|10.0.0.1|6000');
      const recoveryKey = createEventKey(1, ICMP_FP, 'RECOVERY', 'icmp|1|10.0.0.1|6000');
      expect(downKey).not.toBe(recoveryKey);
    });
  });
});
