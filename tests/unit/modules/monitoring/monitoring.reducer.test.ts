import { describe, it, expect } from 'vitest';
import { reduceState, fingerprintToString, createObservationId } from '@/modules/monitoring/monitoring.reducer';
import type { Observation, MonitoringState } from '@/modules/monitoring/monitoring.types';

const FP = fingerprintToString('prtg', true, null, 1001);
const ICMP_FP = fingerprintToString('icmp', true, '10.0.0.1', null);
const GAP_THRESHOLD = 120000;

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  const attemptAt = overrides.attemptAt ?? 1000;
  const completionAt = overrides.completionAt ?? attemptAt;
  const generation = overrides.generation ?? 1;
  return {
    status: 'UP',
    reason: 'up',
    rawStatus: 3,
    source: 'prtg',
    generation,
    attemptAt,
    completionAt,
    observationId: `prtg|${generation}|1001|${completionAt}`,
    rtt: null,
    ...overrides,
  };
}

function makePrev(overrides: Partial<MonitoringState> = {}): MonitoringState {
  return {
    customerId: 1,
    monitorType: 'prtg',
    targetFingerprint: FP,
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

describe('reduceState - stabilization', () => {
  it('two consecutive UP observations set stable UP', () => {
    const prev = reduceState({
      prev: null,
      observation: makeObservation({ status: 'UP', attemptAt: 1000, generation: 1 }),
      now: 1000,
      fingerprint: FP,
      gapThresholdMs: GAP_THRESHOLD,
      monitorType: 'prtg',
      customerId: 1,
    });

    expect(prev.stableHealth).toBe('UNKNOWN');
    expect(prev.consecutiveCount).toBe(1);

    const after = reduceState({
      prev,
      observation: makeObservation({ status: 'UP', attemptAt: 2000, generation: 2 }),
      now: 2000,
      fingerprint: FP,
      gapThresholdMs: GAP_THRESHOLD,
      monitorType: 'prtg',
      customerId: 1,
    });

    expect(after.stableHealth).toBe('UP');
    expect(after.consecutiveCount).toBe(2);
  });

  it('UP → DOWN → DOWN transition records lastTransitionKind=DOWN', () => {
    let state = reduceState({
      prev: null,
      observation: makeObservation({ status: 'UP', attemptAt: 1000, generation: 1 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'UP', attemptAt: 2000, generation: 2 }),
      now: 2000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(state.stableHealth).toBe('UP');

    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'DOWN', attemptAt: 3000, generation: 3 }),
      now: 3000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    expect(state.stableHealth).toBe('UP');
    expect(state.consecutiveCount).toBe(1);

    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'DOWN', attemptAt: 4000, generation: 4, rawStatus: 5 }),
      now: 4000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(state.stableHealth).toBe('DOWN');
    expect(state.lastTransitionKind).toBe('DOWN');
    expect(state.lastTransitionAt).toBe(4000);
  });

  it('DOWN → UP → UP transition records RECOVERY', () => {
    let state = reduceState({
      prev: null,
      observation: makeObservation({ status: 'DOWN', attemptAt: 1000, generation: 1, rawStatus: 5 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'DOWN', attemptAt: 2000, generation: 2, rawStatus: 5 }),
      now: 2000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(state.stableHealth).toBe('DOWN');

    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'UP', attemptAt: 3000, generation: 3 }),
      now: 3000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'UP', attemptAt: 4000, generation: 4 }),
      now: 4000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(state.stableHealth).toBe('UP');
    expect(state.lastTransitionKind).toBe('RECOVERY');
  });
});

describe('reduceState - reset conditions', () => {
  it('gap > threshold resets consecutive count', () => {
    let state = reduceState({
      prev: null,
      observation: makeObservation({ status: 'DOWN', attemptAt: 1000, generation: 1, rawStatus: 5 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'DOWN', attemptAt: 2000, generation: 2, rawStatus: 5 }),
      now: 2000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(state.stableHealth).toBe('DOWN');
    expect(state.consecutiveCount).toBe(2);

    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'DOWN', attemptAt: 200000, generation: 3, rawStatus: 5 }),
      now: 200000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(state.consecutiveCount).toBe(1);
  });

  it('fingerprint change resets state', () => {
    const prev = makePrev({
      targetFingerprint: FP,
      stableHealth: 'DOWN',
      consecutiveCount: 5,
      stableChangedAt: 1000,
    });

    const result = reduceState({
      prev,
      observation: makeObservation({ status: 'UP', attemptAt: 2000, generation: 2 }),
      now: 2000,
      fingerprint: ICMP_FP,
      gapThresholdMs: GAP_THRESHOLD,
      monitorType: 'prtg',
      customerId: 1,
    });

    expect(result.stableHealth).toBe('UNKNOWN');
    expect(result.consecutiveCount).toBe(1);
  });

  it('UNKNOWN observation resets consecutive count but preserves stable', () => {
    let state = reduceState({
      prev: null,
      observation: makeObservation({ status: 'UP', attemptAt: 1000, generation: 1 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'UP', attemptAt: 2000, generation: 2 }),
      now: 2000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    expect(state.stableHealth).toBe('UP');

    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'UNKNOWN', reason: 'sensor_not_found', attemptAt: 3000, generation: 2 }),
      now: 3000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(state.stableHealth).toBe('UP');
    expect(state.consecutiveCount).toBe(0);
    expect(state.latestObservation).toBe('UNKNOWN');
  });
});

describe('reduceState - evidence vs non-evidence', () => {
  it('WARNING resets consecutive, preserves stable', () => {
    const prev = makePrev({ stableHealth: 'UP', consecutiveCount: 3, latestObservation: 'UP' });
    const result = reduceState({
      prev,
      observation: makeObservation({ status: 'WARNING', attemptAt: 1000, generation: 2 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(result.stableHealth).toBe('UP');
    expect(result.consecutiveCount).toBe(0);
    expect(result.latestObservation).toBe('WARNING');
  });

  it('DOWN from raw5 and raw13 both count as DOWN evidence', () => {
    let state = reduceState({
      prev: null,
      observation: makeObservation({ status: 'DOWN', rawStatus: 5, attemptAt: 1000, generation: 1 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'DOWN', rawStatus: 13, attemptAt: 2000, generation: 2 }),
      now: 2000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(state.stableHealth).toBe('DOWN');
  });

  it('first observation alone does not stabilize', () => {
    const result = reduceState({
      prev: null,
      observation: makeObservation({ status: 'DOWN', attemptAt: 1000, generation: 1, rawStatus: 5 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(result.stableHealth).toBe('UNKNOWN');
    expect(result.consecutiveCount).toBe(1);
  });
});

describe('fingerprintToString', () => {
  it('produces deterministic string', () => {
    expect(fingerprintToString('prtg', true, null, 1001)).toBe('prtg|true||1001');
    expect(fingerprintToString('icmp', true, '10.0.0.1', null)).toBe('icmp|true|10.0.0.1|');
  });
});

describe('reduceState - baseline (F2)', () => {
  it('UNKNOWN baseline stabilizes UP without transition', () => {
    let state = reduceState({
      prev: null,
      observation: makeObservation({ status: 'UP', attemptAt: 1000, completionAt: 1000, generation: 1 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    expect(state.stableHealth).toBe('UNKNOWN');
    expect(state.consecutiveCount).toBe(1);

    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'UP', attemptAt: 2000, completionAt: 2000, generation: 2 }),
      now: 2000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    expect(state.stableHealth).toBe('UP');
    expect(state.lastTransitionKind).toBe(null);
    expect(state.lastTransitionAt).toBe(null);
  });

  it('UNKNOWN baseline stabilizes DOWN without transition', () => {
    let state = reduceState({
      prev: null,
      observation: makeObservation({ status: 'DOWN', attemptAt: 1000, completionAt: 1000, generation: 1, rawStatus: 5 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    state = reduceState({
      prev: state,
      observation: makeObservation({ status: 'DOWN', attemptAt: 2000, completionAt: 2000, generation: 2, rawStatus: 5 }),
      now: 2000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    expect(state.stableHealth).toBe('DOWN');
    expect(state.lastTransitionKind).toBe(null);
    expect(state.lastTransitionAt).toBe(null);
  });
});

describe('reduceState - observation identity (F2)', () => {
  it('same observationId is deduplicated', () => {
    const prev = makePrev({
      consecutiveCount: 5,
      stableHealth: 'UP',
      latestObservation: 'UP',
      lastProcessedObservationId: 'prtg|1|1001|500',
    });
    const state = reduceState({
      prev,
      observation: makeObservation({
        status: 'DOWN', attemptAt: 1000, completionAt: 1000, generation: 1, rawStatus: 5,
        observationId: 'prtg|1|1001|500',
      }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(state.consecutiveCount).toBe(5);
    expect(state.stableHealth).toBe('UP');
  });

  it('WARNING/UNUSUAL/PAUSED reset candidate but preserve stable', () => {
    const prev = makePrev({ stableHealth: 'UP', consecutiveCount: 3, latestObservation: 'UP' });

    let result = reduceState({
      prev,
      observation: makeObservation({ status: 'WARNING', reason: 'warning', attemptAt: 1000, completionAt: 1000, generation: 2, rawStatus: 4 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    expect(result.stableHealth).toBe('UP');
    expect(result.consecutiveCount).toBe(0);
    expect(result.latestObservation).toBe('WARNING');

    result = reduceState({
      prev,
      observation: makeObservation({ status: 'UNUSUAL', reason: 'unusual', attemptAt: 1000, completionAt: 1000, generation: 2, rawStatus: 10 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    expect(result.latestObservation).toBe('UNUSUAL');

    result = reduceState({
      prev,
      observation: makeObservation({ status: 'PAUSED', reason: 'paused', attemptAt: 1000, completionAt: 1000, generation: 2, rawStatus: 7 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });
    expect(result.latestObservation).toBe('PAUSED');
  });
});

describe('reduceState - pure reducer (F2)', () => {
  it('does not mutate input prev state', () => {
    const prev = makePrev({ consecutiveCount: 3, stableHealth: 'UP', latestObservation: 'UP' });
    const prevCopy = { ...prev };

    reduceState({
      prev,
      observation: makeObservation({ status: 'DOWN', attemptAt: 1000, completionAt: 1000, generation: 2, rawStatus: 5 }),
      now: 1000, fingerprint: FP, gapThresholdMs: GAP_THRESHOLD, monitorType: 'prtg', customerId: 1,
    });

    expect(prev.consecutiveCount).toBe(prevCopy.consecutiveCount);
    expect(prev.stableHealth).toBe(prevCopy.stableHealth);
    expect(prev.latestObservation).toBe(prevCopy.latestObservation);
  });
});

describe('reduceState - gap reset (F2)', () => {
  it('gap resets candidate without mutating stable health', () => {
    const prev = makePrev({
      stableHealth: 'UP',
      consecutiveCount: 3,
      latestObservation: 'UP',
      lastAttemptAt: 1000,
    });

    const state = reduceState({
      prev,
      observation: makeObservation({ status: 'UP', attemptAt: 2000, completionAt: 2000, generation: 2, rawStatus: 3 }),
      now: 2000,
      fingerprint: FP,
      gapThresholdMs: 500,
      monitorType: 'prtg',
      customerId: 1,
    });

    expect(state.consecutiveCount).toBe(1);
    expect(state.stableHealth).toBe('UP');
    expect(state.stableChangedAt).toBeNull();
  });
});

describe('createObservationId - stable source identity (F2)', () => {
  it('same snapshot produces same ID regardless of processing time', () => {
    const id1 = createObservationId('prtg', 1, '2026-01-01T00:00:00Z', 1001);
    const id2 = createObservationId('prtg', 1, '2026-01-01T00:00:00Z', 1001);
    expect(id1).toBe(id2);
  });

  it('different fetchedAt produces different ID', () => {
    const id1 = createObservationId('prtg', 1, '2026-01-01T00:00:00Z', 1001);
    const id2 = createObservationId('prtg', 1, '2026-01-01T00:00:01Z', 1001);
    expect(id1).not.toBe(id2);
  });
});
