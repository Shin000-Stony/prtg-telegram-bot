export type StableHealth = 'UNKNOWN' | 'UP' | 'DOWN';

export type EvidenceHealth = 'UP' | 'DOWN';

export type ObservationStatus = EvidenceHealth | 'UNKNOWN' | 'WARNING' | 'UNUSUAL' | 'PAUSED';

export type TransitionKind = 'DOWN' | 'RECOVERY' | null;

export interface Observation {
  status: ObservationStatus;
  reason: string;
  rawStatus: number | null;
  source: 'prtg' | 'icmp';
  generation: number;
  attemptAt: number;
  completionAt: number;
  observationId: string;
  rtt: number | null;
}

export interface TargetFingerprint {
  monitorType: string;
  enabled: boolean;
  pingHost: string | null;
  prtgObjectId: number | null;
}

export interface MonitoringState {
  customerId: number;
  monitorType: string;
  targetFingerprint: string;
  stableHealth: StableHealth;
  latestObservation: ObservationStatus;
  latestReason: string;
  latestRawStatus: number | null;
  observedAt: number | null;
  lastAttemptAt: number | null;
  lastObservationAt: number | null;
  lastGoodObservationAt: number | null;
  consecutiveCount: number;
  stableChangedAt: number | null;
  lastTransitionKind: TransitionKind;
  lastTransitionAt: number | null;
  lastProcessedGeneration: number | null;
  lastProcessedObservationId: string | null;
}

export interface MonitoringConfig {
  enabled: boolean;
  prtgPollIntervalMs: number;
  icmpPollIntervalMs: number;
  icmpTimeoutMs: number;
  icmpConcurrency: number;
}

export interface MonitoringCycleResult {
  cycle: 'prtg' | 'icmp';
  generatedAt: number;
  observations: number;
  errors: number;
}

export interface AlertingMonitoringRepositoryPort {
    findAll(): MonitoringState[];
    findById(id: number): MonitoringState | null;
    upsert(state: MonitoringState): void;
    upsertBatch(states: MonitoringState[]): void;
}
