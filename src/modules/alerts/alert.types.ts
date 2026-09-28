export type AlertKind = 'DOWN' | 'RECOVERY';

export type AlertStatus = 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';

export type AlertErrorCode = 
    | 'expired'
    | 'superseded'
    | 'customer_removed'
    | 'customer_disabled'
    | 'customer_pic'
    | 'mapping_removed'
    | 'target_mismatch'
    | 'subscription_revoked'
    | 'group_removed'
    | 'group_disabled'
    | 'rate_limited'
    | 'transient'
    | 'permanent'
    | 'auth_failure'
    | 'formatting'
    | 'stale_observation'
    | 'persistence'
    | 'future_observation'
    | 'opposite_candidate';

export interface AlertEvent {
    readonly eventKey: string;
    readonly kind: AlertKind;
    readonly customerId: number;
    readonly targetFingerprint: string;
    readonly monitorType: 'prtg' | 'icmp';
    readonly triggeringObservationId: string;
    readonly occurrenceAt: number;
    readonly clientId: string;
    readonly customerName: string;
    readonly monitorSource: string;
    readonly targetDisplay: string;
    readonly prtgObjectId?: number;
}

export interface AlertOutboxRow {
    readonly id: number;
    readonly eventKey: string;
    readonly groupChatId: string;
    readonly customerId: number;
    readonly kind: AlertKind;
    readonly targetFingerprint: string;
    readonly monitorType: 'prtg' | 'icmp';
    readonly triggeringObservationId: string | null;
    readonly occurrenceAt: number;
    readonly expiresAt: number;
    readonly clientId: string;
    readonly customerName: string;
    readonly monitorSource: string;
    readonly targetDisplay: string | null;
    readonly status: AlertStatus;
    readonly attempts: number;
    readonly nextAttemptAt: number;
    readonly lastAttemptAt: number | null;
    readonly sentAt: number | null;
    readonly telegramMessageId: number | null;
    readonly errorCode: string | null;
    readonly errorReason: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly prtgObjectId?: number;
}

export interface EligibleRecipient {
    readonly groupChatId: string;
    readonly customerId: number;
    readonly customerName: string;
    readonly receiveAlerts: boolean;
    readonly groupEnabled: boolean;
}

export interface AlertSenderResult {
    readonly success: boolean;
    readonly messageId?: number;
    readonly errorCode?: AlertErrorCode;
    readonly errorReason?: string;
    readonly retryAfterSeconds?: number;
}

export interface AlertSenderPort {
    send(chatId: string, html: string, signal: AbortSignal): Promise<AlertSenderResult>;
}

export interface AlertDispatcherConfig {
    readonly dispatchIntervalMs: number;
    readonly maxEventAgeMs: number;
    readonly maxAttempts: number;
    readonly globalMinIntervalMs: number;
    readonly sameGroupMinIntervalMs: number;
    readonly senderTimeoutMs: number;
    readonly prtgPollIntervalMs: number;
    readonly icmpPollIntervalMs: number;
    readonly holdAdvanceMs: number;
    readonly startupGraceMs: number;
    readonly backoffDelaysMs: number[];
}

export const ALERT_DEFAULTS: Omit<AlertDispatcherConfig, 'senderTimeoutMs'> = {
    dispatchIntervalMs: 1000,
    maxEventAgeMs: 900_000,
    maxAttempts: 5,
    globalMinIntervalMs: 1000,
    sameGroupMinIntervalMs: 3500,
    prtgPollIntervalMs: 60000,
    icmpPollIntervalMs: 30000,
    holdAdvanceMs: 60000,
    startupGraceMs: 3500,
    backoffDelaysMs: [5000, 10000, 20000, 40000, 60000],
};