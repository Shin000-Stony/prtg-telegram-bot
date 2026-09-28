import type { PrtgSensor } from '@/integrations/prtg/prtg.types';
import type { Customer } from '@/modules/customers/customer.types';
import type { PrtgMapping } from '@/modules/mapping/mapping.types';
import type { MonitoringState } from '@/modules/monitoring/monitoring.types';
import { fingerprintToString } from '@/modules/monitoring/monitoring.reducer';
import type {
  EffectiveStatus,
  DataQuality,
  StatusReason,
  StatusDetail,
} from './status.types';

export interface NormalizerInput {
  customer: Customer;
  sensor: PrtgSensor | null;
  mapping: PrtgMapping | null;
  dataQuality: DataQuality;
  fetchedAt: string | null;
  lastKnownStatus: EffectiveStatus | null;
  monitoringState: MonitoringState | null;
  icmpFreshThresholdMs: number;
  icmpNow: () => number;
}

export function normalizeSensorStatus(raw: number | null): { status: EffectiveStatus; reason: StatusReason } {
  if (raw === null) {
    return { status: 'UNKNOWN', reason: 'unknown' };
  }
  switch (raw) {
    case 3:
      return { status: 'UP', reason: 'up' };
    case 4:
      return { status: 'WARNING', reason: 'warning' };
    case 5:
      return { status: 'DOWN', reason: 'down' };
    case 13:
      return { status: 'DOWN', reason: 'down_acknowledged' };
    case 14:
      return { status: 'DOWN', reason: 'down_partial' };
    case 7:
    case 8:
    case 9:
    case 12:
      return { status: 'PAUSED', reason: 'paused' };
    case 10:
      return { status: 'UNUSUAL', reason: 'unusual' };
    case 0:
    case 1:
    case 2:
    case 6:
    case 11:
      return { status: 'UNKNOWN', reason: 'unknown' };
    default:
      return { status: 'UNKNOWN', reason: 'unknown' };
  }
}

export function normalizeCustomerStatus(input: NormalizerInput): { status: EffectiveStatus; reason: StatusReason; dataQuality: DataQuality } {
  const { customer, sensor, mapping, dataQuality, fetchedAt, monitoringState, icmpFreshThresholdMs, icmpNow } = input;

  if (!customer.enabled || customer.monitorType === 'disabled') {
    return { status: 'DISABLED', reason: 'disabled', dataQuality: 'not_applicable' };
  }

  if (customer.monitorType === 'pic') {
    return { status: 'PIC_MANAGED', reason: 'pic_managed', dataQuality: 'not_applicable' };
  }

  if (customer.monitorType === 'icmp') {
    if (monitoringState) {
      return normalizeIcmpStatus(monitoringState, customer, icmpFreshThresholdMs, icmpNow);
    }
    return { status: 'NOT_CHECKED', reason: 'not_checked', dataQuality: 'unavailable' };
  }

  if (customer.monitorType !== 'prtg') {
    return { status: 'NOT_CHECKED', reason: 'not_checked', dataQuality: 'not_applicable' };
  }

  if (!mapping) {
    return { status: 'UNMAPPED', reason: 'unmapped', dataQuality: 'not_applicable' };
  }

  if (dataQuality === 'unavailable' || fetchedAt === null) {
    return { status: 'UNKNOWN', reason: 'no_snapshot', dataQuality: 'unavailable' };
  }

  if (dataQuality === 'stale') {
    return { status: 'UNKNOWN', reason: 'snapshot_stale', dataQuality: 'stale' };
  }

  if (!sensor) {
    return { status: 'UNKNOWN', reason: 'sensor_not_found', dataQuality: 'fresh' };
  }

  if (sensor.sensorType.toLowerCase() !== 'ping') {
    return { status: 'UNKNOWN', reason: 'target_not_ping', dataQuality: 'fresh' };
  }

  return { ...normalizeSensorStatus(sensor.statusRaw), dataQuality: 'fresh' };
}

function normalizeIcmpStatus(
  state: MonitoringState | null,
  customer: Customer,
  freshThresholdMs: number,
  now: () => number,
): { status: EffectiveStatus; reason: StatusReason; dataQuality: DataQuality } {
  const expectedFingerprint = fingerprintToString('icmp', customer.enabled, customer.pingHost, null);
  if (!state || state.lastObservationAt === null || state.targetFingerprint !== expectedFingerprint) {
    return { status: 'NOT_CHECKED', reason: 'not_checked', dataQuality: 'unavailable' };
  }

  const elapsed = now() - state.lastObservationAt;
  if (elapsed > freshThresholdMs) {
    return { status: 'UNKNOWN', reason: 'snapshot_stale', dataQuality: 'stale' };
  }

  if (state.latestObservation === 'UP') {
    return { status: 'UP', reason: 'up', dataQuality: 'fresh' };
  }
  if (state.latestObservation === 'DOWN') {
    return { status: 'DOWN', reason: 'down', dataQuality: 'fresh' };
  }

  return { status: 'UNKNOWN', reason: state.latestReason as StatusReason, dataQuality: 'fresh' };
}

export function resolveStatusDetail(input: NormalizerInput): StatusDetail {
  const { status, reason, dataQuality } = normalizeCustomerStatus(input);

  let lastValue: string | null = null;
  let statusDisplay: string | null = null;
  let rawStatus: number | null = null;
  let fetchedAt: string | null = input.fetchedAt;

  if (input.sensor) {
    lastValue = input.sensor.lastValue ?? null;
    statusDisplay = input.sensor.statusDisplay ?? null;
    rawStatus = input.sensor.statusRaw;
  }

  if (input.monitoringState && input.customer.monitorType === 'icmp') {
    const expectedFingerprint = fingerprintToString('icmp', input.customer.enabled, input.customer.pingHost, null);
    if (input.monitoringState.targetFingerprint === expectedFingerprint) {
      if (input.monitoringState.latestRawStatus !== null) {
        rawStatus = input.monitoringState.latestRawStatus;
      }
      statusDisplay = input.monitoringState.latestObservation;
      if (input.monitoringState.lastObservationAt !== null) {
        fetchedAt = new Date(input.monitoringState.lastObservationAt).toISOString();
      }
    }
  }

  let lastKnown: EffectiveStatus | null = null;
  if (input.customer.monitorType === 'icmp' && input.monitoringState) {
    const expectedFingerprint = fingerprintToString('icmp', input.customer.enabled, input.customer.pingHost, null);
    if (input.monitoringState.targetFingerprint === expectedFingerprint && input.monitoringState.stableHealth !== 'UNKNOWN') {
      lastKnown = input.monitoringState.stableHealth;
    }
  } else if (input.dataQuality === 'stale' && input.lastKnownStatus) {
    lastKnown = input.lastKnownStatus;
  }

  return {
    status,
    reason,
    dataQuality,
    lastValue,
    statusDisplay,
    rawStatus,
    fetchedAt,
    customer: {
      id: input.customer.id,
      clientId: input.customer.clientId,
      name: input.customer.name,
      monitorType: input.customer.monitorType,
      enabled: input.customer.enabled,
    },
    mapping: input.mapping,
    autoUnverified: input.mapping ? input.mapping.mappingMethod === 'auto' && !input.mapping.verified : false,
    lastKnownStatus: lastKnown,
  };
}
