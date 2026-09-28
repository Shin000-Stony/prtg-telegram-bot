-- V6 R2: Add observation identity for restart-safe dedupe
-- SQLite does not support ADD COLUMN IF NOT EXISTS; migration runner tracks applied versions
ALTER TABLE monitoring_states ADD COLUMN last_processed_generation INTEGER;
ALTER TABLE monitoring_states ADD COLUMN last_processed_observation_id TEXT;
