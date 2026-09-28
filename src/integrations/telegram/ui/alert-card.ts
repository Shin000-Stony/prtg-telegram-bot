import type { AlertKind } from '@/modules/alerts/alert.types';
import { htmlEscape } from '@/integrations/telegram/ui/messages';

const MAX_CARD_LENGTH = 3500;

function formatWita(epochMs: number): string {
    return new Date(epochMs).toLocaleString('en-US', {
        timeZone: 'Asia/Makassar',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }) + ' WITA';
}

function truncateBeforeEscape(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '…';
}

export function buildAlertCard(row: { 
    kind: AlertKind;
    client_id: string;
    customer_name: string;
    monitor_source: string;
    target_display: string | null;
    monitor_type: string;
    occurrence_at: number;
    event_key: string;
    prtg_object_id?: number;
}): { html: string; valid: boolean; reason?: string } {
    const kindLabel = row.kind === 'DOWN' ? '🔴 DOWN' : '🟢 RECOVERY';
    const timeStr = formatWita(row.occurrence_at);
    const ref = row.event_key.slice(0, 8);
    const target = row.target_display || '—';

    // Truncate optional raw fields before escaping
    const safeClientId = truncateBeforeEscape(row.client_id, 100);
    const safeCustomerName = truncateBeforeEscape(row.customer_name, 200);
    const safeMonitorSource = truncateBeforeEscape(row.monitor_source, 100);
    const safeTarget = truncateBeforeEscape(target, 200);

    const lines = [
        `<b>${kindLabel}</b>`,
        `<b>Client:</b> ${htmlEscape(safeClientId)}`,
        `<b>Customer:</b> ${htmlEscape(safeCustomerName)}`,
        `<b>Source:</b> ${htmlEscape(safeMonitorSource)}`,
        `<b>Target:</b> ${htmlEscape(safeTarget)}`,
        `<b>Transition:</b> ${timeStr}`,
        `<b>Ref:</b> ${ref}`,
    ];

    const html = lines.join('\n');

    if (html.length > MAX_CARD_LENGTH) {
        return { html: '', valid: false, reason: 'card exceeds max length even after truncation' };
    }

    return { html, valid: true };
}

export function buildDownCard(row: {
    client_id: string;
    customer_name: string;
    monitor_source: string;
    target_display: string | null;
    occurrence_at: number;
    event_key: string;
    monitor_type: string;
    prtg_object_id?: number;
}): { html: string; valid: boolean; reason?: string } {
    return buildAlertCard({ ...row, kind: 'DOWN' });
}

export function buildRecoveryCard(row: {
    client_id: string;
    customer_name: string;
    monitor_source: string;
    target_display: string | null;
    occurrence_at: number;
    event_key: string;
    monitor_type: string;
    prtg_object_id?: number;
    durationMs?: number;
}): { html: string; valid: boolean; reason?: string } {
    return buildAlertCard({ ...row, kind: 'RECOVERY' });
}