import type {
    AlertEvent,
    AlertKind,
    EligibleRecipient,
} from './alert.types';
import type { MonitoringState } from '../monitoring/monitoring.types';
import { fingerprintToString } from '../monitoring/monitoring.reducer';
import { createHash } from 'crypto';

export interface TransitionCaptureInput {
    readonly prevState: MonitoringState | null;
    readonly nextState: MonitoringState;
    readonly customer: {
        readonly id: number;
        readonly clientId: string;
        readonly name: string;
        readonly monitorType: string;
        readonly pingHost: string | null;
        readonly enabled: boolean;
    };
    readonly mapping: {
        readonly prtgObjectId: number;
        readonly deviceName: string | null;
        readonly sensorName: string | null;
    } | null;
    readonly clock: () => number;
    readonly prtgPollIntervalMs: number;
    readonly icmpPollIntervalMs: number;
}

export interface CaptureResult {
    readonly event: AlertEvent | null;
    readonly recipients: EligibleRecipient[];
    readonly diagnostic?: string;
}

export function createEventKey(
    customerId: number,
    targetFingerprint: string,
    kind: AlertKind,
    triggeringObservationId: string
): string {
    // Use JSON tuple for unambiguous serialization
    const tuple = JSON.stringify([customerId, targetFingerprint, kind, triggeringObservationId]);
    return createHash('sha256').update(tuple).digest('hex');
}

export function getMonitorSource(monitorType: string): string {
    return monitorType === 'prtg' ? 'PRTG' : 'ICMP';
}

export function getTargetDisplay(
    monitorType: string,
    mapping: { prtgObjectId: number; deviceName: string | null; sensorName: string | null } | null,
    pingHost: string | null
): string {
    if (monitorType === 'prtg' && mapping) {
        const device = mapping.deviceName ?? 'unknown device';
        const sensor = mapping.sensorName ?? 'unknown sensor';
        return `PRTG ${device} / ${sensor} (obj ${mapping.prtgObjectId})`;
    }
    if (monitorType === 'icmp' && pingHost) {
        return `ICMP ${pingHost}`;
    }
    return monitorType === 'prtg' ? 'PRTG sensor' : 'ICMP host';
}

export function shouldCreateEvent(input: TransitionCaptureInput): CaptureResult {
    const { prevState, nextState, customer, mapping, clock, prtgPollIntervalMs, icmpPollIntervalMs } = input;

    if (!customer.enabled) {
        return { event: null, recipients: [], diagnostic: 'customer disabled' };
    }

    if (customer.monitorType === 'pic' || customer.monitorType === 'disabled') {
        return { event: null, recipients: [], diagnostic: 'monitor type not eligible' };
    }

    if (!prevState) {
        return { event: null, recipients: [], diagnostic: 'no previous state (silent baseline)' };
    }

    if (prevState.targetFingerprint !== nextState.targetFingerprint) {
        return { event: null, recipients: [], diagnostic: 'fingerprint mismatch' };
    }

    // Verify fingerprint matches current customer configuration
    const expectedFingerprint = determineTargetFingerprint(
        customer.monitorType,
        customer.enabled,
        customer.pingHost,
        customer.monitorType === 'prtg' ? (mapping?.prtgObjectId ?? null) : null
    );
    if (nextState.targetFingerprint !== expectedFingerprint) {
        return { event: null, recipients: [], diagnostic: 'target fingerprint mismatch with current config' };
    }

    const prevStable = prevState.stableHealth;
    const nextStable = nextState.stableHealth;

    if (prevStable === 'UNKNOWN' || nextStable === 'UNKNOWN') {
        return { event: null, recipients: [], diagnostic: 'stable health UNKNOWN' };
    }

    if (prevStable === nextStable) {
        return { event: null, recipients: [], diagnostic: 'no stable transition' };
    }

    if (nextState.latestObservation !== nextStable) {
        return { event: null, recipients: [], diagnostic: 'latest observation does not match stable health' };
    }

    const isDown = nextStable === 'DOWN' && prevStable === 'UP';
    const isRecovery = nextStable === 'UP' && prevStable === 'DOWN';
    const kind: AlertKind = isDown ? 'DOWN' : 'RECOVERY';

    if (!isDown && !isRecovery) {
        return { event: null, recipients: [], diagnostic: 'not a DOWN/RECOVERY transition' };
    }

    const pollIntervalMs = customer.monitorType === 'prtg' ? prtgPollIntervalMs : icmpPollIntervalMs;
    const now = clock();
    const observedAt = nextState.observedAt;

    if (observedAt === null || observedAt <= 0) {
        return { event: null, recipients: [], diagnostic: 'invalid observedAt' };
    }

    // Reject future observations (no tolerance)
    if (observedAt > now) {
        return { event: null, recipients: [], diagnostic: 'observedAt in future' };
    }

    const maxAge = pollIntervalMs * 2;
    if (now - observedAt > maxAge) {
        return { event: null, recipients: [], diagnostic: 'observedAt stale beyond poll interval' };
    }

    if (customer.monitorType === 'prtg') {
        if (!mapping) {
            return { event: null, recipients: [], diagnostic: 'PRTG mapping missing' };
        }
    } else if (customer.monitorType === 'icmp') {
        if (!customer.pingHost) {
            return { event: null, recipients: [], diagnostic: 'ICMP pingHost missing' };
        }
    }

    const triggeringObservationId = nextState.lastProcessedObservationId;
    if (!triggeringObservationId) {
        return { event: null, recipients: [], diagnostic: 'missing triggering observation ID' };
    }

    // Use stableChangedAt as the occurrence time for the stable transition
    // This is the actual time the stable health changed, not the observation time
    const occurrenceAt = nextState.stableChangedAt ?? observedAt;

    const eventKey = createEventKey(customer.id, nextState.targetFingerprint, kind, triggeringObservationId);

    const event: AlertEvent = {
        eventKey,
        kind,
        customerId: customer.id,
        targetFingerprint: nextState.targetFingerprint,
        monitorType: customer.monitorType as 'prtg' | 'icmp',
        triggeringObservationId,
        occurrenceAt,
        clientId: customer.clientId,
        customerName: customer.name,
        monitorSource: getMonitorSource(customer.monitorType),
        targetDisplay: getTargetDisplay(customer.monitorType, mapping, customer.pingHost),
        prtgObjectId: mapping?.prtgObjectId,
    };

    return { event, recipients: [] };
}

export function determineTargetFingerprint(
    monitorType: string,
    enabled: boolean,
    pingHost: string | null,
    prtgObjectId: number | null
): string {
    if (monitorType === 'prtg') {
        return fingerprintToString('prtg', enabled, pingHost, prtgObjectId);
    }
    return fingerprintToString('icmp', enabled, pingHost, null);
}

export function getPollIntervalMs(
    monitorType: string,
    prtgPollIntervalMs: number,
    icmpPollIntervalMs: number
): number {
    return monitorType === 'prtg' ? prtgPollIntervalMs : icmpPollIntervalMs;
}