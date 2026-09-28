# Runbook: PRTG Telegram Bot

## Overview

The PRTG Telegram Bot provides real-time infrastructure monitoring alerts via Telegram. It polls PRTG API and ICMP endpoints, computes health state transitions, and routes DOWN/RECOVERY notifications to configured Telegram groups.

## Deployment

### Prerequisites

- Docker 20.10+
- Docker Compose 1.29+
- `.env` file with Telegram credentials and PRTG configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | | Bot token from @BotFather |
| `TELEGRAM_ADMIN_IDS` | Yes | | Comma-separated Telegram user IDs (bot admins) |
| `TELEGRAM_GLOBAL_GROUP_ID` | No | | Global group chat ID for org-wide alerts |
| `DATABASE_PATH` | No | `/data/prtg_bot.db` | SQLite database path (inside container) |
| `PRTG_BASE_URL` | No | | PRTG server base URL |
| `PRTG_USERNAME` | No | | PRTG API username |
| `PRTG_PASSHASH` | No | | PRTG API passhash |
| `PRTG_TLS_REJECT_UNAUTHORIZED` | No | `true` | Reject unauthorized TLS certs (true=strict, false=allow self-signed) |
| `MONITORING_ENABLED` | No | `false` | Enable background monitoring engine |
| `TZ` | No | `Asia/Makassar` | Timezone (WITA) |
| `ALERTS_ENABLED` | No | `false` | Enable alert routing (requires MONITORING_ENABLED=true) |

### Deploy

```bash
git checkout <tag>
cp .env.example .env  # edit with actual values
docker compose build
docker compose up -d
```

### Verify

```bash
docker compose logs -f bot
```

Bot is running when logs show "Bot started" and polling is active.

## Operations

### View Logs

```bash
docker compose logs -f bot                    # live log tail
docker compose logs bot --tail 100            # recent 100 lines
docker compose logs bot --tail 1000 > logs.txt  # save to file
```

### Restart

```bash
docker compose restart bot    # rolling restart
docker compose up -d          # if stopped
docker compose down && docker compose up -d --build  # full redeploy
```

### Configuration Reload

Configuration is read at startup (Zod-validated in `src/config/env.ts`). To apply `.env` changes:

```bash
docker compose down
docker compose up -d
```

## Database Management

### Database Location

Database file: `./data/prtg_bot.db` (mapped to `/data` in container).
Volume: `./data:/data:Z` (with SELinux `:Z` label on host mounts).

Host helper requirements for backup/restore scripts:
- Node.js >= 22 (uses `better-sqlite3` package, already a project dependency)
- `docker compose` CLI (only required for live restore with running bot)
- Offline mode: set `BACKUP_OFFLINE=true` to skip Docker interaction (bot assumed stopped)

**Note on `MONITORING_ENABLED` and `ALERTS_ENABLED`:** Both default to `false`. BACKUP/RESTORE works in either mode.

### Backup

```bash
./scripts/backup-db.sh backup
```

Backups are stored in `./data/backups/` with timestamp suffix.
Uses SQLite backup API via `scripts/sqlite-backup.js` — handles WAL files transparently (checkpoint is internal to the backup API), consistent, validates integrity + full application schema (migrations 1–5, 7 core tables) before publishing the final backup file.

### Restore

```bash
./scripts/backup-db.sh restore ./data/backups/prtg_bot.db.backup.<timestamp>.db
```

Restore flow:
1. Validates backup file (SQLite integrity + application schema, migrations 1–5) **before** touching target, Docker, or staging
2. Copies backup to staging, validates staging copy
3. Determines bot status via `docker compose` context (for online mode): only `running` status will be stopped; any other non-empty state (`paused`, `restarting`, `unknown`) causes abort with nonzero exit
4. Stops bot container **only if running** (no active writers), then **verifies** it stopped
5. Creates recovery backup of current DB (only if target is a healthy DB); corrupt targets are quarantined (DB + WAL + SHM with timestamp suffix)
6. Atomically swaps DB file (staging → `mv`), cleans up stale WAL/SHM after swap
7. Restarts bot **only if it was previously running** and restore succeeded
8. Failure before DB swap aborts with nonzero exit; **target DB/WAL/SHM are preserved** (healthy targets are recovery-backed-up, not modified; corrupted targets are quarantined with originals intact)
9. Failure during quarantine (before swap): abort. Original files remain available at their original or reported quarantine paths. Some files may have already been moved to quarantine before the failure; the operator must verify which files were moved and reconcile any remaining corrupted DB/WAL/SHM manually before retrying restore.
10. Failure after DB swap but during bot start: DB swapped successfully but bot is STOPPED — operator must restart manually. Recovery backup is available.

Offline restore (bot already stopped, no Docker):
```bash
BACKUP_OFFLINE=true ./scripts/backup-db.sh restore ./data/backups/prtg_bot.db.backup.<timestamp>.db
```
`BACKUP_OFFLINE=true` is an explicit operator choice — it does NOT auto-activate on Docker failure.

### Inspect Database

```bash
node -e "const d = new (require('better-sqlite3'))('./data/prtg_bot.db', {readonly:true}); console.log(d.prepare('SELECT COUNT(*) FROM customers').get()); d.close()"
```

## Common Operations

### Add a Customer (Manual)

```
/add_client <client_id> | <name> | <monitor_type> | [ping_host]

Examples:
/add_client CLI-001 | "Customer One" | prtg
/add_client CLI-002 | "Customer Two" | icmp | 10.10.10.10
```

Monitor types: `prtg`, `icmp`, `pic`, `disabled`

### Bulk Import Customers (CSV)

1. Prepare CSV with headers: `client_id,name,monitor_type,ping_host`
2. Upload CSV file to the bot (private chat only)
3. Review preview and confirm with inline keyboard

### Toggle Customer Enable/Disable

```
/enable_client <client_id>
/disable_client <client_id>
```

### Register a Group

In the Telegram group:
```
/register_group
```

### Assign Customer to Group

In the group (admin only):
```
/assign_client <client_id>
```

This grants visibility (`can_view=1`). To receive alerts, toggle explicitly:
```
/group_alerts <client_id> on
/group_alerts <client_id> off
```

> Note: `/assign_client` preserves existing `receive_alerts`. Use `/group_alerts` to toggle alert subscription.

### Global Group

The Global Group is identified by `TELEGRAM_GLOBAL_GROUP_ID` (exact chat ID match). It sees all customers automatically (no `can_view` requirement, including disabled customers). Bot admins in Global Group can toggle alerts per customer via `/group_alerts <client_id> on|off`. The Global Group **cannot** be unregistered.

### Map PRTG Sensor

```
/prtg_inventory refresh             # fetch & cache PRTG devices/sensors
/prtg_search <client_id> <query>    # search cached PRTG objects for a customer
/map_client <client_id> <object_id> # manual mapping
/mappings                           # list all PRTG mappings
```

### Check Status

```
/summary               # overall status summary
/status <client_id>    # single customer status
/down [page]           # list DOWN customers
```

## Access Control

### Access Control Model

**Bot Admins** — defined by `TELEGRAM_ADMIN_IDS`:
- Can manage customers, groups, mappings, CSV imports (requires private chat or Global Group)
- Bot admin status is checked independently of Telegram group admin status — no Telegram group admin condition is required for group mutations

**Global Group** (identified by `TELEGRAM_GLOBAL_GROUP_ID`):
- All customers are visible automatically (no `can_view` requirement, not limited to enabled customers)
- Bot admins in Global Group: can manage customers, mappings, uploads
- Bot admins in Global Group: can toggle per-customer alerts via `/group_alerts <client_id> on|off`
- Global Group cannot be unregistered (even by bot admins)
- `receive_alerts` requires explicit subscription row (`group_customer_access`) — no automatic alert grant

**Ordinary Groups**:
- See only assigned customers (`can_view=1`)
- Receive alerts only if `receive_alerts=1` is explicitly set
- Non-bot-admin members: read-only (cannot manage customers, mappings, or CSV)

**Assign/unassign** preserves existing `receive_alerts` — use `/group_alerts` to toggle alert subscription explicitly.

## Health Checks

The container sets `TZ=Asia/Makassar` for WITA timestamps (`NODE_OPTIONS` includes `--dns-result-order=ipv4first`).
Container runs as UID 1000:1000 (per `docker-compose.yml` `;user` directive, overriding the Dockerfile's `USER nodejs` UID 1001).
Host volume `./data:/data:Z` includes `:Z` SELinux relabel on mounts.
No HTTP health endpoint exists in this build — verify via container status and bot logs.

## Troubleshooting

### Bot Not Responding

1. Check container: `docker compose ps`
2. Check logs: `docker compose logs bot`
3. Verify bot token in `.env`
4. Verify polling status in logs ("Bot started")

### No Status Updates

1. Set `MONITORING_ENABLED=true` in `.env` (required for background engine)
2. Verify PRTG credentials: `PRTG_BASE_URL`, `PRTG_USERNAME`, `PRTG_PASSHASH`
3. Check PRTG connectivity from container
4. Check inventory cache: `/prtg_inventory` command

### Alert Not Received

1. Set `ALERTS_ENABLED=true` and `MONITORING_ENABLED=true` in `.env`
2. Verify group registered: use `/group_clients` in the group to list visible customers
3. Verify alert subscription: `/group_alerts <client_id> on` or `/group_alerts <client_id> off` (the `on`|`off` argument changes the subscription state, not a read-only query)
4. Check alert delivery logs for 429/401 errors

**NOTE:** Live DOWN/RECOVERY delivery has NOT been verified in production. The alert routing logic (V7) is implemented but requires a live environment with active monitoring to confirm end-to-end delivery.

### Database Issues

**Locked DB:** Stop bot, then retry. The monitoring engine and Telegram bot share one SQLite connection.

**Corrupted DB:**
```bash
./scripts/backup-db.sh restore ./data/backups/prtg_bot.db.backup.<last-known-good>
```

**Inspect schema:**
```bash
node -e "const d = new (require('better-sqlite3'))('./data/prtg_bot.db', {readonly:true}); console.log(d.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all()); d.close()"
```

## Upgrade & Rollback

### Upgrade
```bash
# 1. Backup current DB
./scripts/backup-db.sh backup

# 2. Pull new code
git pull origin main
git checkout <new-tag>

# 3. Rebuild and restart
docker compose pull bot
docker compose up -d --build
```

### Rollback
```bash
# 1. Stop bot
docker compose stop bot

# 2. Restore previous DB
./scripts/backup-db.sh restore ./data/backups/prtg_bot.db.backup.<last-known-good>

# 3. Rebuild with previous tag
git checkout <previous-tag>
docker compose up -d --build
```

## Security Notes

- Bot admin IDs via `TELEGRAM_ADMIN_IDS` (never hardcode in code)
- PRTG credentials in `.env` — never commit
- Database at `/data` — back up regularly
- `PRTG_TLS_REJECT_UNAUTHORIZED=true` by default (strict TLS); set to `false` to accept self-signed PRTG certs
- Container runs as UID 1000:1000 (non-root)
- All dynamic values HTML-escaped before sending to Telegram
