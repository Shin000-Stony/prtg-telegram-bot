-- V6: Monitoring states for persistent health tracking
CREATE TABLE IF NOT EXISTS monitoring_states (
  customer_id INTEGER PRIMARY KEY,
  monitor_type TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL,
  stable_health TEXT NOT NULL DEFAULT 'UNKNOWN',
  latest_observation TEXT NOT NULL DEFAULT 'UNKNOWN',
  latest_reason TEXT NOT NULL DEFAULT 'unknown',
  latest_raw_status INTEGER,
  observed_at TEXT,
  last_attempt_at TEXT,
  last_observation_at TEXT,
  last_good_observation_at TEXT,
  consecutive_count INTEGER NOT NULL DEFAULT 0,
  stable_changed_at TEXT,
  last_transition_kind TEXT,
  last_transition_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_monitoring_states_health ON monitoring_states(stable_health);
