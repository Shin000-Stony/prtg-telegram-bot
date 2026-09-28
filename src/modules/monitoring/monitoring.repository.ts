import { getDatabase, runInTransaction } from '@/infrastructure/database/database';
import type { MonitoringState } from './monitoring.types';
import { AppError } from '@/core/errors/app-error';

function rowToState(row: Record<string, unknown>): MonitoringState {
  return {
    customerId: row.customer_id as number,
    monitorType: row.monitor_type as string,
    targetFingerprint: row.target_fingerprint as string,
    stableHealth: (row.stable_health as MonitoringState['stableHealth']) ?? 'UNKNOWN',
    latestObservation: (row.latest_observation as MonitoringState['latestObservation']) ?? 'UNKNOWN',
    latestReason: (row.latest_reason as string) ?? 'unknown',
    latestRawStatus: row.latest_raw_status as number | null,
    observedAt: row.observed_at ? new Date(row.observed_at as string).getTime() : null,
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at as string).getTime() : null,
    lastObservationAt: row.last_observation_at ? new Date(row.last_observation_at as string).getTime() : null,
    lastGoodObservationAt: row.last_good_observation_at ? new Date(row.last_good_observation_at as string).getTime() : null,
    consecutiveCount: (row.consecutive_count as number) ?? 0,
    stableChangedAt: row.stable_changed_at ? new Date(row.stable_changed_at as string).getTime() : null,
    lastTransitionKind: (row.last_transition_kind as MonitoringState['lastTransitionKind']) ?? null,
    lastTransitionAt: row.last_transition_at ? new Date(row.last_transition_at as string).getTime() : null,
    lastProcessedGeneration: (row.last_processed_generation as number) ?? null,
    lastProcessedObservationId: (row.last_processed_observation_id as string) ?? null,
  };
}

function stateToRow(state: MonitoringState): Record<string, unknown> {
  return {
    customer_id: state.customerId,
    monitor_type: state.monitorType,
    target_fingerprint: state.targetFingerprint,
    stable_health: state.stableHealth,
    latest_observation: state.latestObservation,
    latest_reason: state.latestReason,
    latest_raw_status: state.latestRawStatus,
    observed_at: state.observedAt ? new Date(state.observedAt).toISOString() : null,
    last_attempt_at: state.lastAttemptAt ? new Date(state.lastAttemptAt).toISOString() : null,
    last_observation_at: state.lastObservationAt ? new Date(state.lastObservationAt).toISOString() : null,
    last_good_observation_at: state.lastGoodObservationAt ? new Date(state.lastGoodObservationAt).toISOString() : null,
    consecutive_count: state.consecutiveCount,
    stable_changed_at: state.stableChangedAt ? new Date(state.stableChangedAt).toISOString() : null,
    last_transition_kind: state.lastTransitionKind,
    last_transition_at: state.lastTransitionAt ? new Date(state.lastTransitionAt).toISOString() : null,
    last_processed_generation: state.lastProcessedGeneration,
    last_processed_observation_id: state.lastProcessedObservationId,
  };
}

const UPSERT_COLUMNS = [
  'customer_id', 'monitor_type', 'target_fingerprint', 'stable_health', 'latest_observation',
  'latest_reason', 'latest_raw_status', 'observed_at', 'last_attempt_at', 'last_observation_at',
  'last_good_observation_at', 'consecutive_count', 'stable_changed_at', 'last_transition_kind',
  'last_transition_at', 'last_processed_generation', 'last_processed_observation_id',
  'created_at', 'updated_at',
];

const UPSERT_SQL = `
  INSERT INTO monitoring_states (
    ${UPSERT_COLUMNS.join(', ')}
  ) VALUES (${UPSERT_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(customer_id) DO UPDATE SET
    monitor_type = excluded.monitor_type,
    target_fingerprint = excluded.target_fingerprint,
    stable_health = excluded.stable_health,
    latest_observation = excluded.latest_observation,
    latest_reason = excluded.latest_reason,
    latest_raw_status = excluded.latest_raw_status,
    observed_at = excluded.observed_at,
    last_attempt_at = excluded.last_attempt_at,
    last_observation_at = excluded.last_observation_at,
    last_good_observation_at = excluded.last_good_observation_at,
    consecutive_count = excluded.consecutive_count,
    stable_changed_at = excluded.stable_changed_at,
    last_transition_kind = excluded.last_transition_kind,
    last_transition_at = excluded.last_transition_at,
    last_processed_generation = excluded.last_processed_generation,
    last_processed_observation_id = excluded.last_processed_observation_id,
    updated_at = excluded.updated_at
`;

export class MonitoringRepository {
  private getDb() {
    return getDatabase();
  }

  upsert(state: MonitoringState): void {
    const row = stateToRow(state);
    const now = new Date().toISOString();
    const args = UPSERT_COLUMNS.map(col => col === 'created_at' ? now : col === 'updated_at' ? now : row[col as keyof typeof row]);

    try {
      this.getDb().prepare(UPSERT_SQL).run(...args);
    } catch (error) {
      throw AppError.database('Failed to upsert monitoring state', { originalError: String(error) });
    }
  }

  findById(customerId: number): MonitoringState | null {
    const row = this.getDb().prepare('SELECT * FROM monitoring_states WHERE customer_id = ?').get(customerId) as Record<string, unknown> | undefined;
    return row ? rowToState(row) : null;
  }

  findAll(): MonitoringState[] {
    const rows = this.getDb().prepare('SELECT * FROM monitoring_states').all() as Record<string, unknown>[];
    return rows.map(rowToState);
  }

  findAllByMonitorType(monitorType: string): MonitoringState[] {
    const rows = this.getDb().prepare('SELECT * FROM monitoring_states WHERE monitor_type = ?').all(monitorType) as Record<string, unknown>[];
    return rows.map(rowToState);
  }

  deleteByCustomerId(customerId: number): boolean {
    const stmt = this.getDb().prepare('DELETE FROM monitoring_states WHERE customer_id = ?');
    const result = stmt.run(customerId);
    return result.changes > 0;
  }

  upsertBatch(states: MonitoringState[]): void {
    if (states.length === 0) return;

    runInTransaction((db) => {
      const stmt = db.prepare(UPSERT_SQL);
      for (const state of states) {
        const row = stateToRow(state);
        const now = new Date().toISOString();
        const args = UPSERT_COLUMNS.map(col => col === 'created_at' ? now : col === 'updated_at' ? now : row[col as keyof typeof row]);
        stmt.run(...args);
      }
    });
  }
}

export const monitoringRepository = new MonitoringRepository();
