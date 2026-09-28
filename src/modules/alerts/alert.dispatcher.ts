import { getLogger } from '@/core/logger';
import type {
    AlertDispatcherConfig,
    AlertSenderPort,
    AlertErrorCode,
    AlertOutboxRow,
} from './alert.types';
import { alertRepository } from './alert.repository';
import { getDatabase } from '@/infrastructure/database/database';
import { customerRepository } from '@/modules/customers/customer.repository';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { monitoringRepository } from '../monitoring/monitoring.repository';
import { fingerprintToString } from '../monitoring/monitoring.reducer';
import { buildDownCard, buildRecoveryCard } from '@/integrations/telegram/ui/alert-card';
import { htmlEscape } from '@/integrations/telegram/ui/messages';

const ALERT_DEFAULTS = {
    dispatchIntervalMs: 1000,
    maxEventAgeMs: 900_000,
    maxAttempts: 5,
    globalMinIntervalMs: 1000,
    sameGroupMinIntervalMs: 3500,
    senderTimeoutMs: 10_000,
    backoffDelaysMs: [5000, 10000, 20000, 40000, 60000],
};

export class AlertDispatcher {
    private readonly logger = getLogger();
    private readonly config: AlertDispatcherConfig;
    private readonly sender: AlertSenderPort;
    private readonly clock: () => number;
    private readonly globalChatId: string;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private stopPromise: Promise<void> | null = null;
    private isStopping = false;
    private lastGlobalSend = 0;
    private lastGroupSend = new Map<string, number>();
    private activeSendController: AbortController | null = null;
    private activeSendPromise: Promise<void> | null = null;
    private rateLimitedUntil = 0;
    private pacingTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
    private startupGraceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        config: { sender: AlertSenderPort; globalChatId: string } & Partial<AlertDispatcherConfig>,
        clock: () => number = Date.now
    ) {
        this.config = { ...ALERT_DEFAULTS, ...config } as AlertDispatcherConfig;
        this.sender = config.sender;
        this.clock = clock;
        this.globalChatId = config.globalChatId;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.isStopping = false;
        this.stopPromise = null;
        this.logger.info('Alert dispatcher started');
        // Startup recovery: reset any stranded sending rows
        const resetCount = alertRepository.resetSendingToPending(this.clock());
        if (resetCount > 0) {
            this.logger.info({ count: resetCount }, 'Recovered stranded sending rows on startup');
        }
        // Respect startup grace period before first dispatch
        const graceMs = this.config.startupGraceMs ?? 3500;
        if (graceMs > 0) {
            this.startupGraceTimer = setTimeout(() => {
                this.startupGraceTimer = null;
                if (this.running && !this.isStopping) {
                    this.scheduleNext();
                }
            }, graceMs);
        } else {
            this.scheduleNext();
        }
    }

    async stop(): Promise<void> {
        if (this.stopPromise) {
            return this.stopPromise;
        }
        this.isStopping = true;
        this.stopPromise = this.doStop();
        return this.stopPromise;
    }

    private async doStop(): Promise<void> {
        this.logger.info('Stopping alert dispatcher');
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.startupGraceTimer) {
            clearTimeout(this.startupGraceTimer);
            this.startupGraceTimer = null;
        }
        // Clear all pacing timers and resolve their promises
        for (const [timer, resolve] of this.pacingTimers) {
            clearTimeout(timer);
            resolve(); // Resolve the waiting promise
        }
        this.pacingTimers.clear();
        if (this.activeSendController) {
            this.activeSendController.abort();
        }
        if (this.activeSendPromise) {
            await this.activeSendPromise.catch(() => undefined);
        }
        this.running = false;
        this.isStopping = false;
        this.logger.info('Alert dispatcher stopped');
    }

    private scheduleNext(): void {
        if (!this.running || this.isStopping) return;
        this.timer = setTimeout(() => this.runOnce(), this.config.dispatchIntervalMs);
    }

    async runOnce(): Promise<void> {
        if (!this.running || this.isStopping) return;
        if (this.activeSendPromise) return;

        this.activeSendPromise = this.processBatch();
        try {
            await this.activeSendPromise;
        } catch {
            // Safe error logging - no raw error objects
            this.logger.error({ err: 'UnexpectedError' }, 'processBatch threw unexpected error');
        } finally {
            this.activeSendPromise = null;
            if (this.running && !this.isStopping) {
                this.scheduleNext();
            }
        }
    }
private async processBatch(): Promise<void> {
        const now = this.clock();

        // Check worker-wide 429 cooldown before processing any row
        if (this.rateLimitedUntil > now) {
            this.logger.debug({ until: this.rateLimitedUntil }, 'Rate limited, skipping batch');
            return;
        }

        const rows = alertRepository.findPendingDue(now, 50);

        for (const row of rows) {
            if (!this.running || this.isStopping) break;

            // Check worker-wide 429 cooldown BEFORE each request
            if (this.rateLimitedUntil > this.clock()) {
                this.logger.debug({ until: this.rateLimitedUntil }, 'Rate limited before request, stopping batch');
                return;
            }

            const recheck = await this.recheckEligibility(row, now);
            if (!recheck.eligible) {
                if (recheck.hold) {
                    // HOLD: advance due time without consuming attempt, don't cancel
                    const holdDelay = this.config.holdAdvanceMs ?? 60000;
                    alertRepository.deferPending(row.id, this.clock() + holdDelay, this.clock());
                    this.logger.debug({ rowId: row.id, reason: recheck.reason }, 'Alert held for re-evaluation');
                    continue;
                }
                alertRepository.markCancelled(row.id, recheck.reason!, recheck.reason!, now);
                continue;
            }

            // Budget check: exhausted rows must reach terminal state without sending
            if (row.attempts >= this.config.maxAttempts) {
                this.logger.info({ rowId: row.id, attempts: row.attempts, maxAttempts: this.config.maxAttempts }, 'Row exhausted maxAttempts, marking failed');
                alertRepository.markFailedPending(row.id, 'transient', 'max attempts reached', this.clock());
                continue;
            }

            // Pace BEFORE claim - wait for pacing first
            await this.enforcePacing(row.groupChatId);

            // Check for stop/revocation/expiry after pacing wait
            if (!this.running || this.isStopping) {
                this.logger.debug({ rowId: row.id }, 'Dispatcher stopped during pacing, not claiming');
                continue;
            }

            const postPaceRecheck = await this.recheckEligibility(row, this.clock());
            if (!postPaceRecheck.eligible) {
                this.logger.debug({ rowId: row.id, reason: postPaceRecheck.reason }, 'Alert ineligible after pacing');
                if (postPaceRecheck.hold) {
                    alertRepository.deferPending(row.id, this.clock() + (this.config.holdAdvanceMs ?? 60000), this.clock());
                } else {
                    alertRepository.markCancelled(row.id, postPaceRecheck.reason!, postPaceRecheck.reason!, this.clock());
                }
                continue;
            }

            // Claim NOW - after pacing and all rechecks
            const claimed = alertRepository.claimSending(row.id, 'pending', this.clock());
            if (!claimed) continue;

            // Get the updated row with incremented attempts
            const updatedRow = alertRepository.findById(row.id);
            if (!updatedRow) continue;

            const finalRecheck = await this.recheckEligibility(updatedRow, this.clock());
            if (!finalRecheck.eligible) {
                alertRepository.markCancelled(updatedRow.id, finalRecheck.reason!, finalRecheck.reason!, this.clock());
                continue;
            }

            const controller = new AbortController();
            this.activeSendController = controller;
            // Start timeout ONLY around the send (after claim and pacing)
            const timeout = setTimeout(() => controller.abort(), this.config.senderTimeoutMs);

            try {
                const cardHtml = this.buildCardHtml(updatedRow);
                const result = await this.sender.send(updatedRow.groupChatId, cardHtml, controller.signal);
                clearTimeout(timeout);
                this.logger.info({ rowId: updatedRow.id, success: result.success, errorCode: result.errorCode, retryAfter: result.retryAfterSeconds }, 'Sender result');

                if (result.success) {
                    try {
                        const markSentResult = alertRepository.markSent(updatedRow.id, result.messageId!, this.clock());
                        if (!markSentResult) {
                            // DB acknowledgement failure - row was deleted/cancelled, don't resend
                            this.logger.warn({ rowId: updatedRow.id, errorReason: 'db_ack_failed' }, 'DB acknowledgement failed - row deleted/cancelled');
                            // Check durable state before suspending
                            const durableRow = alertRepository.findById(updatedRow.id);
                            if (durableRow && (durableRow.status === 'sending' || durableRow.status === 'pending')) {
                                // Only suspend if row is still in a non-terminal state (unexplained failure)
                                this.logger.error({ rowId: updatedRow.id, errorReason: 'db_ack_exception' }, 'DB acknowledgement failure, suspending dispatcher');
                                this.isStopping = true;
                                break;
                            }
                            // Row was legitimately deleted/cancelled - don't suspend for this
                        }
                    } catch {
                        // DB acknowledgement failure - suspend dispatcher without awaiting own active promise
                        this.logger.error({ rowId: updatedRow.id, errorReason: 'db_ack_exception' }, 'DB acknowledgement failure, suspending dispatcher');
                        this.isStopping = true;
                        break;
                    }
                    this.logger.info({ rowId: updatedRow.id, messageId: result.messageId }, 'Alert sent');
                } else if (result.errorCode === 'rate_limited') {
                    // Worker-wide 429 cooldown - stop current batch immediately
                    const retryAfter = result.retryAfterSeconds;
                    const retryAfterSeconds = (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0)
                        ? retryAfter
                        : this.getNormalBackoffSeconds(); // Use configured backoff for invalid/missing retry_after
                    this.rateLimitedUntil = this.clock() + retryAfterSeconds * 1000;
                    // Budget check: if exhausted, mark failed instead of retrying
                    if (updatedRow.attempts >= this.config.maxAttempts) {
                        alertRepository.markFailed(updatedRow.id, 'transient', 'max attempts reached', this.clock());
                    } else {
                        const nextAttempt = this.clock() + retryAfterSeconds * 1000;
                        alertRepository.scheduleRetry(updatedRow.id, nextAttempt, this.clock());
                    }
                    this.logger.info({ rowId: updatedRow.id, retryAfter: retryAfterSeconds, rateLimitedUntil: this.rateLimitedUntil }, 'Rate limited, stopping batch and setting worker cooldown');
                    // Stop processing this batch - remaining items will be picked up after cooldown
                    return;
                } else if (result.errorCode === 'transient') {
                    if (updatedRow.attempts >= this.config.maxAttempts) {
                        alertRepository.markFailed(updatedRow.id, 'transient', 'max attempts reached', this.clock());
                    } else {
                        const nextAttempt = this.backoff(updatedRow.attempts);
                        alertRepository.scheduleRetry(updatedRow.id, nextAttempt, this.clock());
                    }
                } else if (result.errorCode === 'permanent' || result.errorCode === 'auth_failure') {
                    alertRepository.markFailed(updatedRow.id, result.errorCode!, result.errorReason!, this.clock());
                    if (result.errorCode === 'auth_failure') {
                        this.logger.error('Authentication failure, suspending dispatcher');
                        // Suspend without awaiting own batch to avoid deadlock
                        this.isStopping = true;
                        break;
                    }
                } else if (result.errorCode === 'persistence') {
                    // DB ack failure - suspend dispatcher without awaiting own active promise
                    this.logger.error({ rowId: updatedRow.id }, 'DB persistence failure, suspending dispatcher');
                    this.isStopping = true;
                    break;
                } else {
                    alertRepository.markFailed(updatedRow.id, result.errorCode!, result.errorReason!, this.clock());
                }
            } catch (error) {
                clearTimeout(timeout);
                if (error instanceof DOMException && error.name === 'AbortError') {
                    this.logger.warn({ rowId: updatedRow.id }, 'Alert send aborted');
                } else {
                    // Safe error logging - no raw error objects, use fixed reason
                    const safeReason = error instanceof Error ? 'Error' : 'Unknown error';
                    this.logger.warn({ rowId: updatedRow.id, errorReason: safeReason }, 'Alert send error');
                    alertRepository.markFailed(updatedRow.id, 'transient', safeReason, this.clock());
                }
            } finally {
                this.activeSendController = null;
            }

            // Check stop after each send
            if (!this.running || this.isStopping) break;
        }
    }

    private async suspendOnPersistenceFailure(): Promise<void> {
        // Suspend without awaiting our own activeSendPromise to avoid deadlock
        this.logger.error('Suspending dispatcher due to DB persistence failure');
        // Don't await stop() here as it would wait for activeSendPromise
        // Just signal stop - the stop() method will handle the rest
        this.isStopping = true;
        // The runOnce loop will break and scheduleNext won't be called
    }

    private async recheckEligibility(row: AlertOutboxRow, now: number): Promise<{ eligible: boolean; hold?: boolean; reason?: AlertErrorCode }> {
        if (now >= row.expiresAt) return { eligible: false, reason: 'expired' };

        const customer = customerRepository.findById(row.customerId);
        if (!customer || !customer.enabled) return { eligible: false, reason: 'customer_removed' };
        if (customer.monitorType === 'pic') return { eligible: false, reason: 'customer_pic' };

        const mapping = mappingRepository.findByCustomerId(row.customerId);
        if (row.monitorType === 'prtg' && !mapping) return { eligible: false, reason: 'mapping_removed' };

        // Use canonical fingerprint from V6 helper
        const expectedFingerprint = fingerprintToString(
            row.monitorType as 'prtg' | 'icmp',
            customer.enabled,
            customer.pingHost,
            row.monitorType === 'prtg' ? (mapping?.prtgObjectId ?? null) : null
        );
        if (row.targetFingerprint !== expectedFingerprint) {
            return { eligible: false, reason: 'target_mismatch' };
        }

        // Verify current customer type matches event's monitorType
        if (customer.monitorType !== row.monitorType) {
            return { eligible: false, reason: 'target_mismatch' };
        }

const state = monitoringRepository.findById(row.customerId);
        if (!state) return { eligible: false, reason: 'superseded' };

        // Capture latestObservation as string before type narrowing
        const latestObservationStr = String(state.latestObservation);

        // Check if state matches - RECOVERY maps to UP for stableHealth
        const expectedStableHealth = row.kind === 'RECOVERY' ? 'UP' : row.kind;
        if (state.stableHealth !== expectedStableHealth || state.targetFingerprint !== row.targetFingerprint) {
            return { eligible: false, reason: 'superseded' };
        }

        // Compare event's captured stable transition identity with current state
        // For DOWN: event should capture DOWN transition; for RECOVERY: event should capture RECOVERY transition
        if (row.kind === 'DOWN') {
            if (state.lastTransitionKind !== 'DOWN') {
                return { eligible: false, reason: 'superseded' };
            }
        } else {
            // RECOVERY - should have RECOVERY transition
            if (state.lastTransitionKind !== 'RECOVERY') {
                return { eligible: false, reason: 'superseded' };
            }
        }

        // Compare event's captured stable transition time with current state's stableChangedAt
        // The event's occurrenceAt should match the state's stableChangedAt for the transition
        // If they differ, a newer transition has occurred - cancel as superseded (not hold)
        if (state.stableChangedAt !== null && row.occurrenceAt !== state.stableChangedAt) {
            return { eligible: false, reason: 'superseded' };
        }

        // HOLD for UNKNOWN, WARNING, UNUSUAL, PAUSED observations (check BEFORE stableHealth comparison to avoid type narrowing)
        if (latestObservationStr === 'UNKNOWN' || latestObservationStr === 'WARNING' || 
            latestObservationStr === 'UNUSUAL' || latestObservationStr === 'PAUSED') {
            return { eligible: false, hold: true, reason: 'stale_observation' };
        }

        // HOLD logic: latest observation must match stable health and be fresh
        if (latestObservationStr !== expectedStableHealth) {
            return { eligible: false, hold: true, reason: 'stale_observation' };
        }

        // Check observation freshness using injected poll intervals
        const pollIntervalMs = customer.monitorType === 'prtg'
            ? this.config.prtgPollIntervalMs ?? 60000
            : this.config.icmpPollIntervalMs ?? 30000;
        const maxAge = pollIntervalMs * 2;
        if (state.observedAt === null || now - state.observedAt > maxAge) {
            return { eligible: false, hold: true, reason: 'stale_observation' };
        }

        // Reject future observations (strict, no tolerance)
        if (state.observedAt !== null && state.observedAt > now) {
            return { eligible: false, hold: true, reason: 'future_observation' };
        }

        // Check for opposite candidate - if stableHealth is opposite of what we're alerting
        if (row.kind === 'DOWN' && state.stableHealth === 'UP') {
            return { eligible: false, hold: true, reason: 'opposite_candidate' };
        }
        if (row.kind === 'RECOVERY' && state.stableHealth === 'DOWN') {
            return { eligible: false, hold: true, reason: 'opposite_candidate' };
        }

        // Subscription check
        const subscription = getDatabase().prepare(`
            SELECT receive_alerts FROM group_customer_access WHERE customer_id = ? AND group_chat_id = ?
        `).get(row.customerId, row.groupChatId) as { receive_alerts: number } | undefined;
        if (!subscription || subscription.receive_alerts === 0) return { eligible: false, reason: 'subscription_revoked' };

        // Global group: allow even if disabled (explicit subscription already checked)
        if (row.groupChatId !== this.globalChatId) {
            const group = getDatabase().prepare('SELECT enabled FROM telegram_groups WHERE chat_id = ?').get(row.groupChatId) as { enabled: number } | undefined;
            if (!group || group.enabled === 0) return { eligible: false, reason: 'group_disabled' };
        }

        return { eligible: true };
    }

    private backoff(attempts: number): number {
        const delays = this.config.backoffDelaysMs ?? [5000, 10000, 20000, 40000, 60000];
        // attempts is 1-based after claim, convert to 0-based index for delays array
        const index = Math.min(Math.max(attempts - 1, 0), delays.length - 1);
        return this.clock() + (delays[index] || 60000);
    }

    private getNormalBackoffSeconds(): number {
        const delays = this.config.backoffDelaysMs ?? [5000, 10000, 20000, 40000, 60000];
        // Use first delay as default backoff in seconds
        return Math.ceil((delays[0] || 5000) / 1000);
    }

    private async enforcePacing(groupChatId: string): Promise<void> {
        if (this.isStopping) return;
        const now = this.clock();
        const sinceGlobal = now - this.lastGlobalSend;
        if (sinceGlobal < this.config.globalMinIntervalMs) {
            const delay = this.config.globalMinIntervalMs - sinceGlobal;
            await this.cancellableSleep(delay);
        }
        const sinceGroup = now - (this.lastGroupSend.get(groupChatId) || 0);
        if (sinceGroup < this.config.sameGroupMinIntervalMs) {
            const delay = this.config.sameGroupMinIntervalMs - sinceGroup;
            await this.cancellableSleep(delay);
        }
        this.lastGlobalSend = this.clock();
        this.lastGroupSend.set(groupChatId, this.clock());
    }

    private cancellableSleep(ms: number): Promise<void> {
        if (ms <= 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
            if (this.isStopping) {
                resolve();
                return;
            }
            const timer = setTimeout(() => {
                this.pacingTimers.delete(timer);
                resolve();
            }, ms);
            this.pacingTimers.set(timer, resolve);
            if (this.isStopping) {
                clearTimeout(timer);
                this.pacingTimers.delete(timer);
                resolve();
            }
        });
    }

    private buildCardHtml(row: AlertOutboxRow): string {
        const cardResult = row.kind === 'DOWN'
            ? buildDownCard({
                client_id: row.clientId,
                customer_name: row.customerName,
                monitor_source: row.monitorSource,
                target_display: row.targetDisplay,
                occurrence_at: row.occurrenceAt,
                event_key: row.eventKey,
                monitor_type: row.monitorType,
                prtg_object_id: row.prtgObjectId,
            })
            : buildRecoveryCard({
                client_id: row.clientId,
                customer_name: row.customerName,
                monitor_source: row.monitorSource,
                target_display: row.targetDisplay,
                occurrence_at: row.occurrenceAt,
                event_key: row.eventKey,
                monitor_type: row.monitorType,
                prtg_object_id: row.prtgObjectId,
            });

if (!cardResult.valid) {
            this.logger.warn({ rowId: row.id, reason: cardResult.reason }, 'Alert card invalid, using fallback');
            // Fallback to minimal safe card with HTML escaping - reuse htmlEscape from ui/messages
            const esc = htmlEscape;
            return `<b>${row.kind === 'DOWN' ? '🔴 DOWN' : '🟢 RECOVERY'}</b>\n<b>Client:</b> ${esc(row.clientId)}\n<b>Customer:</b> ${esc(row.customerName)}\n<b>Ref:</b> ${esc(row.eventKey.slice(0, 8))}`;
        }

        return cardResult.html;
    }
}

export function createAlertDispatcher(
    config: Partial<AlertDispatcherConfig> & { sender: AlertSenderPort; globalChatId: string },
    clock: () => number = Date.now
): AlertDispatcher {
    return new AlertDispatcher(config, clock);
}