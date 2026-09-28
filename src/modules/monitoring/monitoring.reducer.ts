import type {
  MonitoringState,
  Observation,
  EvidenceHealth,
  ObservationStatus,
  StableHealth,
  TransitionKind,
} from './monitoring.types';

export { EvidenceHealth };
export type { MonitoringState, Observation, ObservationStatus, StableHealth, TransitionKind };

const STABILIZATION_THRESHOLD = 2;

export interface ReducerParams {
  prev: MonitoringState | null;
  observation: Observation;
  now: number;
  fingerprint: string;
  gapThresholdMs: number;
  monitorType: string;
  customerId: number;
}

export function fingerprintToString(monitorType: string, enabled: boolean, pingHost: string | null, prtgObjectId: number | null): string {
  return `${monitorType}|${enabled}|${pingHost ?? ''}|${prtgObjectId ?? ''}`;
}

export function createObservationId(source: 'prtg' | 'icmp', generation: number, sourceId: string, completionAt: number): string {
  return `${source}|${generation}|${sourceId}|${completionAt}`;
}

export function isEvidenceHealth(status: ObservationStatus): status is EvidenceHealth {
  return status === 'UP' || status === 'DOWN';
}

export function isNonEvidenceObservable(status: ObservationStatus): boolean {
  return status === 'WARNING' || status === 'UNUSUAL' || status === 'PAUSED';
}

function createInitialState(customerId: number, monitorType: string, fingerprint: string): MonitoringState {
  return {
    customerId,
    monitorType,
    targetFingerprint: fingerprint,
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
  };
}

export function reduceState(params: ReducerParams): MonitoringState {
  const { observation, now, fingerprint, gapThresholdMs, monitorType, customerId } = params;

  let prev = params.prev;

  if (!prev) {
    prev = createInitialState(customerId, monitorType, fingerprint);
  }

  if (prev.targetFingerprint !== fingerprint) {
    prev = createInitialState(customerId, monitorType, fingerprint);
  }

  const obsStatus = observation.status;

  if (prev.lastAttemptAt !== null && now - prev.lastAttemptAt > gapThresholdMs) {
    prev = { ...prev, consecutiveCount: 0 };
  }

  if (
    observation.observationId !== null &&
    prev.lastProcessedObservationId !== null &&
    prev.lastProcessedObservationId === observation.observationId
  ) {
    return prev;
  }

  if (obsStatus === 'UNKNOWN') {
    return {
      ...prev,
      latestObservation: 'UNKNOWN',
      latestReason: observation.reason,
      latestRawStatus: observation.rawStatus,
      observedAt: observation.completionAt,
      lastAttemptAt: observation.attemptAt,
      lastObservationAt: observation.completionAt,
      consecutiveCount: 0,
      lastProcessedGeneration: observation.generation,
      lastProcessedObservationId: observation.observationId,
    };
  }

  if (obsStatus === 'WARNING' || obsStatus === 'UNUSUAL' || obsStatus === 'PAUSED') {
    return {
      ...prev,
      latestObservation: obsStatus,
      latestReason: observation.reason,
      latestRawStatus: observation.rawStatus,
      observedAt: observation.completionAt,
      lastAttemptAt: observation.attemptAt,
      lastObservationAt: observation.completionAt,
      consecutiveCount: 0,
      lastProcessedGeneration: observation.generation,
      lastProcessedObservationId: observation.observationId,
    };
  }

  const sameAsPrev = obsStatus === prev.latestObservation;
  const newCount = sameAsPrev ? prev.consecutiveCount + 1 : 1;

  const baseResult: MonitoringState = {
    ...prev,
    latestObservation: obsStatus,
    latestReason: observation.reason,
    latestRawStatus: observation.rawStatus,
    observedAt: observation.completionAt,
    lastAttemptAt: observation.attemptAt,
    lastObservationAt: observation.completionAt,
    consecutiveCount: newCount,
    lastProcessedGeneration: observation.generation,
    lastProcessedObservationId: observation.observationId,
  };

  if (obsStatus === 'UP') {
    baseResult.lastGoodObservationAt = observation.completionAt;
  }

  if (newCount < STABILIZATION_THRESHOLD) {
    return baseResult;
  }

  const stableHealth: StableHealth = obsStatus;

  let lastTransitionKind: TransitionKind = prev.lastTransitionKind;
  let lastTransitionAt = prev.lastTransitionAt;

  if (prev.stableHealth !== stableHealth && prev.stableHealth !== 'UNKNOWN') {
    lastTransitionKind = obsStatus === 'DOWN' ? 'DOWN' : 'RECOVERY';
    lastTransitionAt = now;
  }

  return {
    ...baseResult,
    stableHealth: stableHealth,
    stableChangedAt: prev.stableHealth !== stableHealth ? now : prev.stableChangedAt,
    lastTransitionKind,
    lastTransitionAt,
  };
}
