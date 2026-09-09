# Troubleshooting Guide — PRTG Telegram Monitoring Bot

Version 7.0 (Production Operations)

---

## 1. Telegram Bot Not Responding

### Checklist

1. Is the container running?
   ```bash
   docker compose ps
   ```
2. Check recent logs:
   ```bash
   docker compose logs --tail=100 prtg-bot
   ```
3. Look for Telegram API errors:
   - `401: Unauthorized` — bot token is invalid or revoked.
   - `429: Too Many Requests` — rate-limited by Telegram.
   - `ETIMEDESTER` or DNS errors — check internet connectivity.

### Common Fixes

- Verify `TELEGRAM_BOT_TOKEN` in `.env`.
- Verify the bot is not banned in the target group/channel.
- Ensure the container has outbound HTTPS (port 443) access to `api.telegram.org`.
- The bot uses IPv4-first DNS resolution (hardcoded in `src/index.js`). If IPv6 is preferred on the host, this may help.

---

## 2. PRTG API Errors

### Checklist

```text
office network connectivity
PRTG address reachable (https://PRTG_SERVER)
credentials / passhash valid
TLS / self-signed handling
API timeout
PRTG server health
```

### Common Fixes

- Verify `PRTG_URL` is the bare base URL (no `/api/` suffix).
- Verify `PRTG_USERNAME` and `PRTG_PASSHASH` are correct.
- The PRTG client uses a scoped `https.Agent({ rejectUnauthorized: false })` for self-signed TLS. This is only applied to PRTG API requests — Telegram HTTPS is unaffected.
- If PRTG returns HTTP 403, the passhash may be expired or the user lacks API permissions.
- PRTG API timeout is 60 seconds. If PRTG is slow, check PRTG server load.

---

## 3. Direct Ping Errors

### Checklist

```text
DIRECT_PING_ENABLED=true
valid IPv4 address
container NET_RAW capability
iputils-ping installed in image
host routing
firewall
```

### Common Fixes

- The Docker image installs `iputils-ping` and runs with `cap_add: NET_RAW`.
- Ensure `DIRECT_PING_ENABLED` is `true` in `.env` (or `compose.yaml`).
- Ping uses `spawn` / `execFile` — no shell interpolation. This is intentional and secure.
- Verify the container can reach the target IP:
  ```bash
  docker compose exec prtg-bot ping -c 3 <customer_ip>
  ```
- If ping works manually but not from the bot, check the monitoring cycle logs for ICMP execution errors.

---

## 4. Customer Shows UNKNOWN

`UNKNOWN` means the active monitoring backend could not determine the customer's state.

### Check

- PRTG API error (see section 2).
- Missing live result from PRTG.
- Ping execution failure.
- Backend runtime issue.

### Do NOT confuse with:

| State | Meaning |
|---|---|
| UNRESOLVED | No PRTG device mapping yet |
| PAUSED | PRTG sensors are all paused |
| PIC MANAGED | Externally monitored |
| DISABLED | Bot monitoring is turned off |

---

## 5. Customer Shows UNRESOLVED

### Checklist

```text
scope = prtg
mapping_status
device ObjID
sensor mapping
PRTG search
```

### Steps

1. Run `/mapping <id>` to see current mapping status.
2. Run `/find_prtg <query>` with the customer name or service ID.
3. Run `/find_prtg_deep <query>` for a deeper search.
4. If a device is found, run `/map_client <id> <objid>`.
5. Verify with `/status <id>`.

---

## 6. Customer Shows PAUSED

1. Run `/mapping <id>` to see sensor details.
2. Verify in the PRTG web UI whether the pause was intentional.
3. If unintentional, resume sensors in PRTG directly.
4. Do NOT manually force a DOWN state via the bot.

---

## 7. Database Errors

### Checklist

```text
/data volume mounted
database file exists
file permissions
disk space
SQLite integrity
backup availability
```

### Verification

```bash
# Check database file exists
docker compose exec prtg-bot ls -la /data/prtg_bot.db

# Check disk space
docker compose exec prtg-bot df -h /data
```

Optional safe integrity check (if sqlite CLI is available on host):

```bash
sqlite3 /data/prtg_bot.db "PRAGMA integrity_check;"
```

Or from inside the container using Node:

```bash
docker compose exec prtg-bot node -e "
const Database = require('better-sqlite3');
const db = new Database('/data/prtg_bot.db');
console.log(db.prepare('PRAGMA integrity_check').get());
db.close();
"
```

---

## 8. Docker Problems

### Container Not Starting

```bash
docker compose ps
docker compose logs prtg-bot
```

Check for:
- Missing environment variables (see section 9).
- Port conflicts.
- Volume mount errors.

### Restart Container

```bash
docker compose restart prtg-bot
```

### DO NOT

```bash
docker compose down -v
```

This removes the named volume `prtg_data` and destroys the database. Only use `down -v` if intentionally destroying all data.

---

## 9. Missing Environment Variables

Startup validates required variables. If any are missing, you will see:

```text
[CONFIG] Missing required environment variable: TELEGRAM_BOT_TOKEN
```

### Required Variables

| Variable | Purpose |
|---|---|
| `PRTG_URL` | PRTG server base URL |
| `PRTG_USERNAME` | PRTG API user |
| `PRTG_PASSHASH` | PRTG passhash |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |

### Optional Variables (with defaults)

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_CHAT_ID` | (none) | Target chat for alerts |
| `TELEGRAM_ADMIN_IDS` | (none) | Comma-separated admin user IDs |
| `DATABASE_PATH` | `/data/prtg_bot.db` | SQLite database path |
| `BACKUP_DIR` | `/backups` | Backup file directory |
| `POLL_INTERVAL` | 30 | Monitoring poll interval (seconds) |
| `DOWN_CONFIRM_COUNT` | 2 | DOWN alerts after N consecutive failures |
| `RECOVERY_CONFIRM_COUNT` | 2 | RECOVERY alerts after N consecutive OK |
| `ALERTS_ENABLED` | false | Enable/disable alert notifications |
| `DIRECT_PING_ENABLED` | true | Enable ICMP fallback |
| `DIRECT_PING_TIMEOUT` | 2 | Ping timeout (seconds) |
| `DIRECT_PING_COUNT` | 1 | Ping count per check |
| `DIRECT_PING_CONCURRENCY` | 5 | Concurrent ping workers |
| `PRTG_DISCOVERY_INTERVAL` | 900 | Device discovery interval (seconds) |
| `TZ` | Asia/Makassar | Timezone for logs and timestamps |

---

## 10. Alert Issues

### No Alerts Received

1. Run `/test_alert` to verify Telegram delivery.
2. Check `ALERTS_ENABLED=true` in `.env`.
3. Check `TELEGRAM_CHAT_ID` is set and correct.
4. Check `TELEGRAM_ADMIN_IDS` includes your Telegram user ID.

### False DOWN Alerts

1. Check `DOWN_CONFIRM_COUNT` (default: 2).
2. Review flap protection — the bot requires N consecutive DOWN polls before alerting.
3. Check monitoring cycle logs: `[MONITOR] DOWN confirmation: N polls`

### Missed Recovery Alerts

1. Check `RECOVERY_CONFIRM_COUNT` (default: 2).
2. Verify the bot process did not restart during the recovery window.

### Non-Active Classifications Sending Alerts

This is a bug. Verify:
- `paused_prtg`, `unresolved_prtg`, `pic_managed`, and `disabled` customers do NOT send DOWN alerts.
- Only `active_prtg` and `active_icmp` classifications are alert-eligible.

---

## 11. Timezone Issues

### Check Container Timezone

```bash
docker compose exec prtg-bot sh -c 'echo $TZ && date'
```

Expected:
```text
Asia/Makassar
```

### Fix

Ensure `TZ=Asia/Makassar` is in `.env` or in `compose.yaml` environment section.
