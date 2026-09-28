-- Migration 005: Alert outbox table
-- Creates the alert_outbox table for durable alert delivery queue

-- Main alert outbox table
CREATE TABLE IF NOT EXISTS alert_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL,
    group_chat_id TEXT NOT NULL,
    customer_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('DOWN', 'RECOVERY')),
    target_fingerprint TEXT NOT NULL,
    monitor_type TEXT NOT NULL CHECK (monitor_type IN ('prtg', 'icmp')),
    triggering_observation_id TEXT,
    occurrence_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    monitor_source TEXT NOT NULL,
    target_display TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_attempt_at INTEGER,
    sent_at INTEGER,
    telegram_message_id INTEGER,
    error_code TEXT,
    error_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    prtg_object_id INTEGER,
    UNIQUE (event_key, group_chat_id),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (group_chat_id) REFERENCES telegram_groups(chat_id) ON DELETE CASCADE
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_alert_outbox_pending_due ON alert_outbox (status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_alert_outbox_recipient_last_attempt ON alert_outbox (group_chat_id, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_alert_outbox_customer ON alert_outbox (customer_id);
CREATE INDEX IF NOT EXISTS idx_alert_outbox_event_key ON alert_outbox (event_key);