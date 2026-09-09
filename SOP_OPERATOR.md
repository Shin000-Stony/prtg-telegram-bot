# SOP — PRTG Telegram Monitoring Bot Operator

Version 7.0 (Production Operations)

## 1. Daily Check

1. Open Telegram.
2. Run `/health`.
3. Run `/status`.
4. Inspect any 🔴 DOWN, 🟡 WARNING, or ⚪ UNKNOWN entries.
5. If unresolved count > 0, run `/clients` to identify affected customers.

If `/health` shows any red ❌ status, escalate per incident procedure.

---

## 2. When a DOWN Alert Arrives

1. Identify the customer from the alert (look for `#<id>` in the message).
2. Identify the backend (PRTG sensor or Direct ICMP).
3. Run `/status <id>` to confirm current state.
4. If PRTG backend:
   - Verify PRTG web UI for the device/sensor.
   - Check for PRTG-side pause, maintenance window, or credential issue.
5. If ICMP backend:
   - Verify network reachability to the customer IP.
   - Check for routing or firewall issues on the host.
6. Check whether the issue is already known (internal ticketing / outage board).
7. Escalate according to office procedure.
8. Wait for RECOVERY alert. Do not manually close the incident until confirmed.

Do not attempt manual PRTG configuration changes from the bot.

---

## 3. Unresolved Customer

An unresolved customer (`🧩 UNRESOLVED`) has `scope = prtg` but no PRTG device mapping.

1. Run `/status <id>` — confirm classification is `UNRESOLVED`.
2. Run `/mapping <id>` — view PRTG search status.
3. If customer should be in PRTG:
   - Run `/find_prtg <query>` (broad search).
   - Run `/find_prtg_deep <query>` (deep search).
   - Run `/find_prtg_sensor <query>` (sensor-level search).
4. If a matching device is found:
   - Run `/map_client <id> <objid>` to map the device.
   - Run `/map_sensor <id> <objid>` to map a specific primary sensor.
5. If no match found, verify the customer IP/service ID in PRTG manually.

Never treat an unresolved customer as DOWN. It is not monitored.

---

## 4. Paused Customer

An paused customer (`⏸ PAUSED-ONLY`) has all PRTG sensors paused.

`PAUSED ≠ DOWN`.

1. Run `/status <id>` — confirm classification is `PAUSED-ONLY`.
2. Verify in PRTG web UI whether the pause is expected.
3. If the pause was unintentional:
   - Resume sensors in PRTG directly.
   - The bot will resume monitoring on the next cycle.
4. The bot does NOT send DOWN alerts for paused customers.

---

## 5. PIC Managed Customer

A PIC-managed customer (`👤 PIC MANAGED`) is monitored externally by a third party.

1. Run `/status <id>` — confirm classification is `PIC MANAGED`.
2. The bot does NOT monitor or alert on these customers.
3. Do not attempt to map or change their configuration.
4. Contact the responsible PIC if issues are reported.

---

## 6. Direct Ping Customer

An active ICMP customer (`🌐 DIRECT ICMP PING`) is monitored via direct ping fallback (not in PRTG).

1. Run `/status <id>` — confirm backend is `DIRECT ICMP PING`.
2. If the customer is later added to PRTG:
   1. Verify the PRTG device object exists.
   2. Run `/set_scope <id> prtg`.
   3. Run `/map_client <id> <objid>`.
   4. Verify `/status` shows backend as `PRTG SENSOR`.
   5. Confirm direct ping monitoring stops.

---

## 7. Adding a Customer

Run `/add_client` (admin only).

Expected fields:
- name
- IP
- location
- service ID
- description
- scope (`prtg`, `direct_ping`, `pic_managed`, `not_in_prtg`)

After adding, verify with `/status <id>` and `/clients`.

---

## 8. Removing a Customer

Run `/remove_client <id>` (admin only).

Confirmation flow:
1. The bot asks for confirmation with `/confirm_remove`.
2. Reply `/confirm_remove` to proceed, or cancel.

Warning: Removal deletes the customer record and may cascade to delete related mappings and monitoring state. Verify the target ID carefully.

---

## 9. Enable / Disable Customer

- `/enable_client <id>` — re-enables monitoring for a customer.
- `/disable_client <id>` — stops the bot from monitoring a customer.

Difference:
- **Disabled** — the bot ignores the customer entirely.
- **Paused** — the customer exists in PRTG but all sensors are paused.

---

## 10. Mapping

Three mapping levels exist (hierarchy: explicit sensor > manual auto-primary > automatic):

1. **Automatic mapping** — the bot discovers and maps PRTG devices automatically.
2. **Manual device mapping** — `/map_client <id> <objid>` maps a specific device.
3. **Explicit sensor mapping** — `/map_sensor <id> <objid>` maps a specific primary sensor.

To unmap:
- `/unmap_client <id>` — removes the device mapping.

Confirmation flow applies to all mapping changes via `/confirm_map` and `/confirm_unmap`.

---

## 11. Backup

Run (admin only):

```bash
docker compose exec prtg-bot npm run backup
```

Backups are stored in `./backups/` on the host and `/backups` in the container.

Files are named: `prtg_bot_YYYY-MM-DD_HHMMSS.db`

Backups are pruned to the most recent 7 files automatically.

---

## 12. Restore

1. Stop the bot:
   ```bash
   docker compose stop prtg-bot
   ```
2. List available backups:
   ```bash
   docker compose run --rm prtg-bot node scripts/restore.js list
   ```
3. Restore (replace with actual filename):
   ```bash
   docker compose run --rm prtg-bot node scripts/restore.js backups/prtg_bot_2026-09-08_165250.db
   ```
4. Start the bot:
   ```bash
   docker compose up -d
   ```
5. Verify:
   - `/status` shows correct customer count.
   - `/clients` shows all customers.
   - `/health` reports database healthy.

---

## 13. Incident Handling

| Symptom | Action |
|---|---|
| Bot not responding in Telegram | Check `docker compose ps`, then `docker compose logs prtg-bot` |
| `/health` shows ❌ for PRTG API | Verify PRTG URL, credentials, network |
| `/health` shows ❌ for Direct Ping | Verify `DIRECT_PING_ENABLED` and container `NET_RAW` capability |
| False DOWN alert | Check flap protection config (`DOWN_CONFIRM_COUNT`) |
| Missed alert | Check `UP_CONFIRM_COUNT` and monitoring cycle logs |
| Missing customer | Verify `/clients` and database integrity |

Do not restart the bot for a single false alert. Check the monitoring logs first.

---

## 14. Telegram Group Operations

### Registering a Group

1. Add the bot to the Telegram group as admin.
2. An admin runs:
   ```
   /register_group
   ```
3. Bot replies "GROUP REGISTERED" with the Chat ID.

### Assigning Customers to a Group

1. In the group, an admin runs:
   ```
   /assign_group <client_id>
   ```
2. Bot shows a confirmation card with `/confirm_group_assign`.
3. Confirm with `/confirm_group_assign`.

### Configuring Alert Delivery to a Group

By default, newly assigned customers receive alerts (`receive_alerts = 1`). To stop alert delivery while keeping the customer visible in `/status` and `/clients`:

```
/group_alerts <client_id> off
```

To re-enable:
```
/group_alerts <client_id> on
```

Only group admins can use this command. Bot confirms with an alert routing card showing both Visibility and Alert Delivery status.

### Viewing Group-Scoped Status and Client List

In any registered Telegram group:

```
/status
```

- Only assigned customers (with `can_view = 1`) are displayed.
- Unregistered groups receive "GROUP NOT REGISTERED" — no customer data is shown.
- Empty groups receive "NO CUSTOMERS ASSIGNED".
- Private admin `/status` always shows the global view.

```
/clients
```

- Shows a client list of only assigned customers (with `can_view = 1`) in the group.
- Unregistered groups receive "⛔ GROUP NOT REGISTERED" — no customer data is shown.
- Private admin `/clients` always shows the global list of all customers.

### Listing Group Customers

```
/group_clients
```

Shows all customers assigned to the current group with their classification and alert status. Each customer displays `🔔 Alerts: ON` or `🔕 Alerts: OFF`. Only customers with `can_view = 1` are displayed.

### Removing a Group

```
/unregister_group
```

Removes the group and all its customer assignments. Global monitoring is unaffected.
