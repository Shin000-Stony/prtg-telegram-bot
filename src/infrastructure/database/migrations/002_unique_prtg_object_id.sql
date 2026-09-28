-- Migration: Add UNIQUE constraint on prtg_object_id
-- Version: 2
-- Name: unique_prtg_object_id

-- This migration adds a UNIQUE index on prtg_object_id to enforce
-- that one PRTG sensor can only be mapped to one customer.
-- If duplicates exist in the database, this migration will fail
-- with a clear error message, requiring manual resolution.

CREATE UNIQUE INDEX IF NOT EXISTS idx_prtg_mappings_object_unique ON prtg_mappings(prtg_object_id);