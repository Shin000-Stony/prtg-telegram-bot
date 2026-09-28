# Roadmap

## Milestones

### V1 — Foundation (Complete)
**Goal:** Professional architecture, database, basic Telegram commands

- [x] Modular monolith structure
- [x] TypeScript strict configuration
- [x] Zod-validated environment config
- [x] Pino structured logging
- [x] SQLite with migration runner
- [x] Database schema (customers, groups, access, mappings)
- [x] Repository/Service boundaries
- [x] Access control foundation (admin, global group, visibility)
- [x] Telegram bot with middleware (auth, error handling)
- [x] `/help` command
- [x] `/chatid` command
- [x] CSV parser with validation (csv-parse)
- [x] CSV import service (preview, dry-run, transactional)
- [x] PRTG mapping types and matcher (conservative)
- [x] Operator-assisted mapping UX documented
- [x] PRTG client boundary (placeholder)
- [x] ICMP ping client boundary (placeholder)
- [x] Graceful shutdown (SIGINT/SIGTERM)
- [x] Docker multi-stage build
- [x] docker-compose with persistent volume
- [x] Unit tests (config, access, database, CSV, matcher)
- [x] Integration tests (repository, migrations)
- [x] Documentation (README, ARCHITECTURE, DEVELOPMENT, ROADMAP)

### V2 — Customer Registry + CSV Import (Complete)
**Goal:** Full customer CRUD, production CSV import workflow

- [x] `/clients` - list customers with pagination
- [x] `/client <client_id>` - customer details
- [x] `/add_client` - create customer via command
- [x] `/enable_client <client_id>` - enable customer
- [x] `/disable_client <client_id>` - disable customer
- [x] CSV upload workflow
  - Upload → validate → preview → confirm → import
  - Inline keyboard for confirmation
- [x] CSV preview with dry-run
- [x] Duplicate detection (CSV-internal + existing DB)
- [x] Transactional import (bulkCreate in transaction)
- [x] File validation (extension, size, MIME)
- [x] Authorization: Admin + Private/Global Group only
- [x] Integration tests for full import flow

### V3 — Telegram Groups & Access Control (Complete)
**Goal:** Group registration, visibility, alert routing


### V3.1 — Security Fix Verification (Complete)
**Goal:** Verify and fix authorization bypass, prepare for freeze review

- [x] `/register_group` - register current group
- [x] `/unregister_group` - remove group (with confirmation flow)
- [x] `/groups` - list registered groups
- [x] `/assign_client` - grant group access to customer
- [x] `/unassign_client` - revoke access
- [x] `/group_clients` - list customers visible in group
- [x] Visibility vs alerts separation
  - `can_view` - see in lists, status commands
  - `receive_alerts` - get DOWN/RECOVERY notifications
- [x] Global Group implementation
  - Config-based identity (exact chat ID match)
  - Lightweight `telegram_groups` row for FK integrity only
  - Auto-visibility (sees all enabled customers)
  - Alert subscription via explicit `group_customer_access` rows
  - Non-admin members: read-only (cannot manage clients, upload CSV, or unregister)
  - Admin members: can manage clients, toggle alerts, but cannot unregister Global Group
- [x] Group admin commands (enable/disable group)
- [x] Private chat restrictions for mutation commands
- [x] Tests for all group commands (register, unregister, assign, unassign, group-clients, group-alerts)
- [x] Integration tests for Global Group persistence
- [x] Security test suite
- [x] `assignCustomer` preserves `receive_alerts` when passing falsy value (ON CONFLICT CASE logic)
- [x] `updateAccess` deletes row when both `can_view` and `receive_alerts` are false

### V3.2 — Security Hotfix & Freeze Verification (Complete)
**Goal:** Close remaining authorization gaps, verify visibility/alert independence

- [x] F1: Fixed ordinary/unregistered group visibility leakage - admin in unregistered/disabled ordinary group no longer gets all customers; admin in registered ordinary group sees only assigned (can_view=1) customers; non-admin ordinary group no longer sees alerts-only rows
- [x] F2: Fixed unregister confirm to check current admin permission - added `canUnregisterGroup()` to AccessService; handler now verifies current admin permission before consuming token
- [x] F3: Fixed admin bypass in canReceiveAlerts - admin no longer gets automatic true; subscription depends on explicit receive_alerts row
- [x] F4: Fixed alert ON requiring visibility for ordinary groups - removed can_view prerequisite from group_alerts command and repository; explicit ON/OFF now independent of visibility
- [x] F5: Fixed assignment reply showing wrong alert status - command now uses returned access state to show actual alert status
- [x] Updated tests to match corrected behavior
- [x] Updated documentation (ARCHITECTURE, ROADMAP)
- [x] All gates pass: typecheck, lint, 447 tests, build
**Goal:** PRTG integration, device/sensor discovery, mapping

- [ ] PRTG API client implementation
  - Authentication (username/passhash)
  - TLS config per PRTG_TLS_REJECT_UNAUTHORIZED
  - Rate limiting, retries
- [ ] `/prtg_inventory` - fetch and cache PRTG devices/sensors
- [ ] `/prtg_search <query>` - search PRTG objects
- [ ] `/map_client <client_id> <object_id>` - manual mapping
- [ ] `/unmap_client <client_id>` - remove mapping
- [ ] `/mappings` - list all PRTG mappings
- [ ] Auto-mapping command (admin only)
  - Runs matcher on all unmapped PRTG customers
  - Shows preview before applying
- [ ] Mapping status in customer details
- [ ] PRTG object caching with TTL
- [ ] Mapping audit log (who mapped what when)

### V5 — Status Commands
**Goal:** Real-time status from PRTG and ICMP

- [ ] `/status` - overall status summary
- [ ] `/status <client_id>` - single customer status
- [ ] `/status_group` - group-specific status
- [ ] PRTG sensor status polling
  - Status: Up/Down/Warning/Paused
  - Last value, last up/down timestamps
- [ ] ICMP ping execution
  - Configurable timeout, retries
  - Parallel execution with concurrency limit
- [ ] Status formatting (cards, emojis, HTML)
- [ ] Caching layer (in-memory, short TTL)
- [ ] Refresh button on status messages

### V6 — Monitoring Engine
**Goal:** Background scheduler, state tracking

- [x] Scheduler service (configurable intervals via env injection)
  - PRTG poll interval (default 60s)
  - ICMP poll interval (default 30s)
  - ICMP timeout, concurrency
- [x] State machine per customer
  - Stabilization threshold (N=2 consecutive observations)
  - Flap detection (stale → fresh UNKNOWN resets state)
  - Fingerprint reset on mapping change
- [x] Persistent state in database
  - monitoring_states table (SQLite)
  - Upsert batch operations
- [x] Two-cycle design (PRTG + ICMP) — engine does NOT import Telegraf/handler/UI
- [x] Configurable check intervals per customer
- [x] Disable monitoring via env (MONITORING_ENABLED=false)
- [x] Monitoring statistics (uptime %, checks run, consecutive count)
- [x] Health check endpoint (for Docker)
- [x] Engine start/stop with graceful shutdown

### V7 — Alert Routing
**Goal:** DOWN/RECOVERY notifications to groups

- [x] Alert generation on state change (DOWN/RECOVERY transitions)
- [x] Alert deduplication (event key SHA-256, per-recipient dedupe)
- [x] Group alert routing
  - `receive_alerts = 1` → gets notification
  - Global Group → gets all alerts via explicit subscription per customer
- [x] Alert formatting
  - Customer name, client ID
  - Previous/current status
  - Timestamp (Asia/Makassar WITA)
  - PRTG sensor info or ICMP host
  - 3,500 char limit, HTML escaping
- [x] Alert delivery with retries and backoff
- [x] Alert outbox (SQLite) with atomic state+alert writes
- [x] HOLD logic for UNKNOWN/stale/paused/opposite candidates
- [x] Worker-wide 429 cooldown, 401 auth suspension
- [x] DB acknowledgement failure handling
- [x] At-least-once delivery (no exactly-once claim)

### V8 — Production Hardening & Handover
**Goal:** Operational readiness, documentation, testing

- [x] Database backup/restore scripts
  - `scripts/sqlite-backup.js` (SQLite backup API, WAL-transparent)
  - `scripts/validate-db.js` (integrity + full schema validation, migrations 1–5)
  - `scripts/backup-db.sh` (consistent backup, safe atomic restore, fail-closed Docker)
- [x] Runbook documentation (`docs/RUNBOOK.md`)
- [ ] Comprehensive integration tests
- [ ] Load testing (simulated)
- [ ] Configuration validation CLI
- [ ] Log rotation configuration
- [ ] Prometheus metrics endpoint (optional)
- [ ] Health check endpoint
- [ ] Security audit
- [ ] Performance benchmarks
- [ ] Changelog
- [ ] Version tagging strategy

## Timeline Estimate

| Milestone | Est. Weeks | Dependencies |
|-----------|------------|--------------|
| V1 Foundation | 2-3 | None |
| V2 Customer Registry | 2-3 | V1 |
| V3 Groups & Access | 2-3 | V2 |
| V4 PRTG & Mapping | 3-4 | V3 |
| V5 Status Commands | 2-3 | V4 |
| V6 Monitoring Engine | 3-4 | V5 |
| V7 Alert Routing | 2-3 | V6 |
| V8 Hardening | 2-3 | V7 |
| **Total** | **18-26** | |

## Technical Debt to Address

- [ ] Add request ID correlation for logging
- [ ] Implement proper retry with exponential backoff
- [ ] Add circuit breaker for PRTG API
- [ ] Implement structured config for intervals/timeouts
- [ ] Add database connection pooling (if needed)
- [ ] Consider read replicas for scaling
- [ ] Add OpenTelemetry tracing

## Future Considerations

- Web dashboard (separate project)
- Multi-language support
- Plugin system for custom checks
- Webhook support for external integrations
- Kubernetes deployment manifests
- Terraform/Ansible for infrastructure