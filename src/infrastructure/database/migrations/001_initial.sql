-- Initial schema for PRTG Telegram Bot
-- Version: 1
-- Name: initial_schema

-- Customers table - registry of monitored customers
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  monitor_type TEXT NOT NULL CHECK (monitor_type IN ('prtg', 'icmp', 'pic', 'disabled')),
  ping_host TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customers_client_id ON customers(client_id);
CREATE INDEX IF NOT EXISTS idx_customers_enabled ON customers(enabled);

-- Telegram groups table - registered groups for alert routing
CREATE TABLE IF NOT EXISTS telegram_groups (
  chat_id TEXT PRIMARY KEY,
  title TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_telegram_groups_enabled ON telegram_groups(enabled);

-- Group-customer access control - visibility and alert routing
CREATE TABLE IF NOT EXISTS group_customer_access (
  group_chat_id TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  can_view INTEGER NOT NULL DEFAULT 1,
  receive_alerts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_chat_id, customer_id),
  FOREIGN KEY (group_chat_id) REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_customer_access_group ON group_customer_access(group_chat_id);
CREATE INDEX IF NOT EXISTS idx_group_customer_access_customer ON group_customer_access(customer_id);
CREATE INDEX IF NOT EXISTS idx_group_customer_access_alerts ON group_customer_access(receive_alerts);

-- PRTG mappings - separate table for PRTG-specific mapping data
CREATE TABLE IF NOT EXISTS prtg_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL UNIQUE,
  prtg_object_id INTEGER NOT NULL,
  prtg_device_name TEXT,
  prtg_sensor_name TEXT,
  mapping_method TEXT NOT NULL CHECK (mapping_method IN ('auto', 'manual', 'import')),
  confidence REAL,
  verified INTEGER NOT NULL DEFAULT 0,
  mapped_by_telegram_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prtg_mappings_customer ON prtg_mappings(customer_id);
CREATE INDEX IF NOT EXISTS idx_prtg_mappings_object ON prtg_mappings(prtg_object_id);
CREATE INDEX IF NOT EXISTS idx_prtg_mappings_verified ON prtg_mappings(verified);