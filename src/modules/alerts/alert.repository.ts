import { getDatabase } from '@/infrastructure/database/database';
import type {
    AlertEvent,
    AlertOutboxRow,
    AlertStatus,
    AlertErrorCode,
} from './alert.types';

interface DbAlertOutboxRow {
    id: number;
    event_key: string;
    group_chat_id: string;
    customer_id: number;
    kind: string;
    target_fingerprint: string;
    monitor_type: string;
    triggering_observation_id: string | null;
    occurrence_at: number;
    expires_at: number;
    client_id: string;
    customer_name: string;
    monitor_source: string;
    target_display: string | null;
    status: string;
    attempts: number;
    next_attempt_at: number;
    last_attempt_at: number | null;
    sent_at: number | null;
    telegram_message_id: number | null;
    error_code: string | null;
    error_reason: string | null;
    created_at: number;
    updated_at: number;
    prtg_object_id: number | null;
}

function mapRow(row: DbAlertOutboxRow): AlertOutboxRow {
    return {
        id: row.id,
        eventKey: row.event_key,
        groupChatId: row.group_chat_id,
        customerId: row.customer_id,
        kind: row.kind as 'DOWN' | 'RECOVERY',
        targetFingerprint: row.target_fingerprint,
        monitorType: row.monitor_type as 'prtg' | 'icmp',
        triggeringObservationId: row.triggering_observation_id,
        occurrenceAt: row.occurrence_at,
        expiresAt: row.expires_at,
        clientId: row.client_id,
        customerName: row.customer_name,
        monitorSource: row.monitor_source,
        targetDisplay: row.target_display,
        status: row.status as 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed',
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        lastAttemptAt: row.last_attempt_at,
        sentAt: row.sent_at,
        telegramMessageId: row.telegram_message_id,
        errorCode: row.error_code,
        errorReason: row.error_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        prtgObjectId: row.prtg_object_id ?? undefined,
    };
}

export class AlertRepository {
    private get db() {
        return getDatabase();
    }

    insertEvent(
        event: AlertEvent,
        recipients: Array<{ groupChatId: string; customerId: number }>,
        expiresAt: number,
        clock: () => number
    ): void {
        const now = clock();
        const stmt = this.db.prepare(`
            INSERT INTO alert_outbox (
                event_key, group_chat_id, customer_id, kind, target_fingerprint,
                monitor_type, triggering_observation_id, occurrence_at, expires_at,
                client_id, customer_name, monitor_source, target_display,
                status, attempts, next_attempt_at, last_attempt_at,
                sent_at, telegram_message_id, error_code, error_reason,
                created_at, updated_at, prtg_object_id
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, null,
                null, null, null, null, ?, ?, ?
            )
            ON CONFLICT(event_key, group_chat_id) DO NOTHING
        `);

        const insertMany = this.db.transaction((items: readonly (readonly any[])[]) => {
            for (const row of items) {
                stmt.run(...row);
            }
        });

        const rows = recipients.map(({ groupChatId, customerId }) => [
            event.eventKey,
            groupChatId,
            customerId,
            event.kind,
            event.targetFingerprint,
            event.monitorType,
            event.triggeringObservationId,
            event.occurrenceAt,
            expiresAt,
            event.clientId,
            event.customerName,
            event.monitorSource,
            event.targetDisplay,
            now,
            now,
            event.prtgObjectId ?? null,
        ]);

        insertMany(rows);
    }

    findPendingDue(now: number, limit: number): AlertOutboxRow[] {
        const rows = this.db.prepare(`
            SELECT * FROM alert_outbox
            WHERE status = 'pending' AND next_attempt_at <= ?
            ORDER BY next_attempt_at ASC, id ASC
            LIMIT ?
        `).all(now, limit) as DbAlertOutboxRow[];
        return rows.map(mapRow);
    }

    findByEventKeyAndGroup(eventKey: string, groupChatId: string): AlertOutboxRow | null {
        const row = this.db.prepare(`
            SELECT * FROM alert_outbox WHERE event_key = ? AND group_chat_id = ?
        `).get(eventKey, groupChatId) as DbAlertOutboxRow | null;
        return row ? mapRow(row) : null;
    }

    findById(id: number): AlertOutboxRow | null {
        const row = this.db.prepare('SELECT * FROM alert_outbox WHERE id = ?').get(id) as DbAlertOutboxRow | null;
        return row ? mapRow(row) : null;
    }

    claimSending(id: number, expectedStatus: AlertStatus, now: number): boolean {
        const result = this.db.prepare(`
            UPDATE alert_outbox
            SET status = 'sending', attempts = attempts + 1, last_attempt_at = ?, next_attempt_at = ?, updated_at = ?
            WHERE id = ? AND status = ?
        `).run(now, now + 60000, now, id, expectedStatus);
        return result.changes === 1;
    }

    markSent(id: number, messageId: number, now: number): boolean {
        const result = this.db.prepare(`
            UPDATE alert_outbox
            SET status = 'sent', sent_at = ?, telegram_message_id = ?, updated_at = ?
            WHERE id = ? AND status = 'sending'
        `).run(now, messageId, now, id);
        return result.changes === 1;
    }

    markCancelled(id: number, errorCode: AlertErrorCode, reason: string, now: number): boolean {
        const result = this.db.prepare(`
            UPDATE alert_outbox
            SET status = 'cancelled', error_code = ?, error_reason = ?, updated_at = ?
            WHERE id = ? AND status IN ('pending', 'sending')
        `).run(errorCode, reason, now, id);
        return result.changes === 1;
    }

    markFailed(id: number, errorCode: AlertErrorCode, reason: string, now: number): boolean {
        const result = this.db.prepare(`
            UPDATE alert_outbox
            SET status = 'failed', error_code = ?, error_reason = ?, updated_at = ?
            WHERE id = ? AND status = 'sending'
        `).run(errorCode, reason, now, id);
        return result.changes === 1;
    }

    markFailedPending(id: number, errorCode: AlertErrorCode, reason: string, now: number): boolean {
        const result = this.db.prepare(`
            UPDATE alert_outbox
            SET status = 'failed', error_code = ?, error_reason = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'
        `).run(errorCode, reason, now, id);
        return result.changes === 1;
    }

    scheduleRetry(id: number, nextAttemptAt: number, now: number): boolean {
        const result = this.db.prepare(`
            UPDATE alert_outbox
            SET status = 'pending', next_attempt_at = ?, updated_at = ?
            WHERE id = ? AND status = 'sending'
        `).run(nextAttemptAt, now, id);
        return result.changes === 1;
    }

    deferPending(id: number, nextAttemptAt: number, now: number): boolean {
        const result = this.db.prepare(`
            UPDATE alert_outbox
            SET next_attempt_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'
        `).run(nextAttemptAt, now, id);
        return result.changes === 1;
    }

    resetSendingToPending(now: number): number {
        const result = this.db.prepare(`
            UPDATE alert_outbox
            SET status = 'pending', next_attempt_at = ?, updated_at = ?
            WHERE status = 'sending'
        `).run(now, now);
        return result.changes;
    }

    findByEventKey(eventKey: string): AlertOutboxRow[] {
        const rows = this.db.prepare('SELECT * FROM alert_outbox WHERE event_key = ?').all(eventKey) as DbAlertOutboxRow[];
        return rows.map(mapRow);
    }

    findPendingByCustomer(customerId: number): AlertOutboxRow[] {
        const rows = this.db.prepare('SELECT * FROM alert_outbox WHERE customer_id = ? AND status = ?').all(customerId, 'pending') as DbAlertOutboxRow[];
        return rows.map(mapRow);
    }
}

export class EligibleRecipientQuery {
    private get db() {
        return getDatabase();
    }

    findAllForCustomer(customerId: number, globalChatId: string): Array<{
        groupChatId: string;
        customerId: number;
        customerName: string;
        receiveAlerts: boolean;
        groupEnabled: boolean;
    }> {
        const rows = this.db.prepare(`
            SELECT ga.group_chat_id as group_chat_id, c.id as customer_id, c.name as customer_name,
                   ga.receive_alerts as receive_alerts, g.enabled as group_enabled,
                   g.chat_id as group_chat_id_ref
            FROM group_customer_access ga
            JOIN telegram_groups g ON g.chat_id = ga.group_chat_id
            JOIN customers c ON c.id = ga.customer_id
            WHERE ga.customer_id = ? AND ga.receive_alerts = 1
        `).all(customerId) as Array<{
            group_chat_id: string;
            customer_id: number;
            customer_name: string;
            receive_alerts: number;
            group_enabled: number;
        }>;

        return rows.map(row => ({
            groupChatId: row.group_chat_id,
            customerId: row.customer_id,
            customerName: row.customer_name,
            receiveAlerts: row.receive_alerts === 1,
            groupEnabled: row.group_enabled === 1,
        })).filter(r => {
            // Global group: always include if subscribed (explicit receive_alerts=1 already enforced in query)
            if (r.groupChatId === globalChatId) {
                return true;
            }
            // Ordinary groups: only enabled groups
            return r.groupEnabled;
        });
    }
}

export const alertRepository = new AlertRepository();
export const eligibleRecipientQuery = new EligibleRecipientQuery();