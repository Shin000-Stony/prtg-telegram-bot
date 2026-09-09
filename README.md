# PRTG Telegram Monitoring Bot

Bot untuk memonitor customer dari PRTG dan mengirim notifikasi Telegram ketika primary sensor customer berubah status dari UP ke DOWN atau DOWN ke UP.

**Hanya customer yang terdaftar di SQLite yang dimonitor.**

---

## Arsitektur

```text
Telegram
   │
   ▼
PRTG Telegram Bot
   │
   ├── SQLite Registry
   ├── Mapping Inventory
   ├── Monitoring Engine
   └── Alert Engine
            │
            ▼
          PRTG
```

## Monitoring Logic

Hanya customer yang memenuhi kriteria berikut yang dimonitor:

- `enabled = 1`
- `monitoring_scope = prtg` ATAU `not_in_prtg`
- Untuk `prtg`: `mapping_status = mapped` dan memiliki primary sensor aktif
- Untuk `not_in_prtg`: IP address valid untuk direct ICMP ping

### Monitoring Scope Classification

Customer registry mendukung lima kondisi monitoring:

| Classification | Scope | Icon | Arti |
|----------------|-------|------|------|
| Active PRTG | `prtg` | 📡 | Customer dimonitor oleh PRTG sensor. Mapping & primary sensor aktif diperlukan. |
| Active ICMP | `not_in_prtg` | 🌐 | Customer tidak ada di PRTG utama, tetapi dimonitor via Direct ICMP Ping. |
| Paused PRTG | `prtg` (semua sensor paused) | ⏸ | Customer terhubung ke PRTG, tetapi semua sensor dalam keadaan paused. |
| Unresolved PRTG | `prtg` | 🟡 | Customer terhubung ke PRTG, ada sensor aktif, tetapi tidak ada primary sensor yang dapat dipakai (status sensor tidak dikenali/unknown). |
| PIC Managed | `pic_managed` | 👤 | Monitoring dikelola oleh PIC/tim lain. Tidak dimonitor oleh bot. |
| Disabled | `disabled` | ❌ | Customer dihapus dari monitoring sama sekali. |

Classification ditentukan otomatis oleh `customer-commands.js` berdasarkan mapping status, sensor status, dan monitoring scope. Gunakan `/set_scope` untuk mengubah scope secara eksplisit.

### Monitoring Backend

Setiap customer aktif menggunakan salah satu backend:

| Backend | Icon | Sumber Observasi |
|---------|------|------------------|
| `prtg` | 📡 PRTG SENSOR | PRTG API sensor status |
| `icmp_ping` | 🌐 DIRECT ICMP PING | ICMP ping ke customer IP |
| `none` | None | Tidak dimonitor |

Backend ditentukan oleh `monitoring_scope`:
- `prtg` → backend = `prtg`
- `not_in_prtg` → backend = `icmp_ping`
- `pic_managed` → backend = `none`

Gunakan `/set_scope` untuk mengubah scope secara eksplisit.

### Konfirmasi Status

Bot tidak langsung mengirim alert pada pertama kali status berubah. Bot menunggu konfirmasi dari beberapa polling berturut-turut:

```text
UP
 ↓
DOWN 1/2
 ↓
DOWN 2/2
 ↓
DOWN ALERT
```

Dan untuk recovery:

```text
DOWN
 ↓
UP 1/2
 ↓
UP 2/2
 ↓
RECOVERY ALERT
```

Ini mencegah alert palsu akibat flapping.

### Status Types

| Status | Icon | Meaning |
|--------|------|---------|
| UP | 🟢 | Sensor正常 |
| DOWN | 🔴 | Sensor tidak reachable |
| WARNING | 🟡 | Sensor melaporkan peringatan |
| UNUSUAL | 🟠 | Sensor melaporkan nilai tidak biasa |
| UNKNOWN | ⚪ | PRTG API tidak dapat diakses atau status tidak dikenali |
| PAUSED | ⏸ | Sensor di-pause, tidak untuk monitoring |
| UNMAPPED | - | Customer belum memiliki mapping PRTG yang valid |

**Important distinctions:**
- `UNKNOWN` (⚪) ≠ `DOWN` (🔴) ≠ `PAUSED` (⏸) ≠ `PIC MANAGED` (👤)
- `NULL` monitoring state = never monitored before (not UNKNOWN)
- `UNRESOLVED` means PRTG-connected but no usable primary sensor found
- `PIC MANAGED` customers are intentionally not monitored by this bot

---

## Instalasi

### Persyaratan

- Node.js 22
- npm
- SQLite (sudah included via better-sqlite3)

### Langkah-langkah

1. Clone repository
2. Salin `.env.example` menjadi `.env`
3. Isi konfigurasi di `.env`
4. Install dependencies: `npm ci`
5. Inisialisasi database: `npm run db:init`
6. Seed data customer (opsional): `npm run db:seed`
7. Start bot: `npm start`

---

## Konfigurasi

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Environment mode |
| `TZ` | No | `Asia/Makassar` | Timezone |
| `DATABASE_PATH` | No | `./data/prtg_bot.db` | Path SQLite database |
| `PRTG_URL` | Yes | - | URL PRTG server |
| `PRTG_USERNAME` | Yes | - | Username PRTG |
| `PRTG_PASSHASH` | Yes | - | Passhash PRTG |
| `TELEGRAM_BOT_TOKEN` | Yes | - | Telegram bot token |
| `TELEGRAM_CHAT_ID` | No | - | Chat ID untuk alert |
| `TELEGRAM_ADMIN_IDS` | No | - | Admin IDs (comma separated) |
| `POLL_INTERVAL` | No | `30` | Interval polling dalam detik |
| `MONITOR_INTERVAL_SECONDS` | No | `30` | Alternatif interval polling |
| `DOWN_CONFIRM_COUNT` | No | `2` | Jumlah konfirmasi DOWN |
| `RECOVERY_CONFIRM_COUNT` | No | `2` | Jumlah konfirmasi RECOVERY |
| `ALERTS_ENABLED` | No | `false` | Enable/disable alerts |
| `DEBUG_MONITORING` | No | `false` | Enable detailed monitoring logs |
| `DIRECT_PING_ENABLED` | No | `true` | Enable ICMP fallback |
| `DIRECT_PING_TIMEOUT` | No | `2` | Ping timeout (seconds) |
| `DIRECT_PING_COUNT` | No | `1` | Ping count per check |
| `DIRECT_PING_CONCURRENCY` | No | `5` | Concurrent ping workers |
| `PRTG_DISCOVERY_INTERVAL` | No | `900` | Device discovery interval (seconds) |
| `BACKUP_DIR` | No | `/backups` | Backup file directory |

---

## Docker Deployment

### Docker Deployment

### Build dan Start

```bash
docker compose build
docker compose up -d
```

### Lihat Logs

```bash
docker compose logs -f prtg-bot
```

### Restart

```bash
docker compose restart
```

### Stop

```bash
docker compose down
```

> **Warning:** Do NOT use `docker compose down -v` — this destroys the persistent database volume.

### Backup

```bash
docker compose exec prtg-bot npm run backup
```

### Restore

```bash
# List backups
docker compose exec prtg-bot node scripts/restore.js list

# Restore specific backup
docker compose exec prtg-bot node scripts/restore.js /backups/prtg_bot_2026-09-08_165250.db
```

---

## Telegram Commands

### User Commands

| Command | Deskripsi |
|---------|-----------|
| `/start` | Mulai bot |
| `/help` | Tampilkan bantuan |
| `/clients` | Daftar customer terdaftar |
| `/client <id>` | Detail customer |
| `/status` | Ringkasan status monitoring |
| `/status <id>` | Detail status monitoring customer |
| `/status` (di group terdaftar) | Hanya customer yang di-assign ke grup |
| `/clients` (di group terdaftar) | Hanya customer yang di-assign ke grup |
| `/group_clients` (di group terdaftar) | Daftar customer yang di-assign ke grup |
| `/group_alerts <client_id> on\|off` (di group terdaftar, admin only) | Toggle alert delivery per customer ke grup ini |


| `/id` | Lihat Telegram User ID |
| `/chatid` | Lihat Chat ID |

### Admin Commands

| Command | Deskripsi |
|---------|-----------|
| `/admin_test` | Tes hak akses admin |
| `/add_client` | Tambah customer |
| `/remove_client <id>` | Hapus customer |
| `/enable_client <id>` | Aktifkan customer |
| `/disable_client <id>` | Nonaktifkan customer |
| `/set_scope <id> <scope> [catatan]` | Ubah monitoring scope |
| `/confirm_scope` | Konfirmasi perubahan scope |
| `/mapping` | Ringkasan mapping PRTG |
| `/mapping <id>` | Detail mapping customer |
| `/find_prtg <query>` | Fast PRTG device search |
| `/find_prtg_deep <query>` | Deep PRTG device search |
| `/find_prtg_sensor <query>` | Deep PRTG sensor search |
| `/prtg_device <objid>` | Inspect PRTG device & sensors |
| `/prtg_sensor <objid>` | Inspect PRTG sensor |
| `/map_client <id> <objid>` | Hubungkan customer ke device PRTG |
| `/map_sensor <id> <sensor_objid>` | Hubungkan customer ke sensor tertentu |
| `/unmap_client <id>` | Hapus mapping PRTG |
| `/confirm_map` | Konfirmasi mapping manual |
| `/confirm_map_sensor` | Konfirmasi explicit sensor mapping |
| `/confirm_unmap` | Konfirmasi unmap |
| `/health` | Cek kesehatan bot |
| `/test_alert` | Tes notifikasi Telegram |
| `/cancel` | Batalkan proses aktif |

### Manual Mapping Workflow

Jika customer belum ter-mapping otomatis:

1. **Normal search**: `/find_prtg <query>` (cepat, limited)
2. **Deep search** (jika perlu): `/find_prtg_deep <query>` (broader, dengan scoring)
3. **Inspect device**: `/prtg_device <objid>` (lihat device & sensors)
4. **Validate manually**: Pastikan PRTG device benar-benar sesuai
5. **Map customer**: `/map_client <client_id> <objid>` (dapatkan preview)
6. **Confirm**: `/confirm_map` (konfirmasi mapping)

Jika perlu menghapus mapping:

1. `/unmap_client <client_id>` (dapatkan preview)
2. `/confirm_unmap` (hapus mapping)

> **Safety**: Deep search tidak pernah mapping otomatis. Admin selalu menjadi otoritas akhir.

### Explicit Sensor Mapping Workflow

Untuk customer pada shared/aggregation router:

1. **Sensor search**: `/find_prtg_sensor <query>` (contoh: `/find_prtg_sensor CITRA`)
2. **Inspect sensor**: `/prtg_sensor <sensor_objid>` (validasi parent device, host, status)
3. **Map to sensor**: `/map_sensor <client_id> <sensor_objid>` (dapatkan preview)
4. **Confirm**: `/confirm_map_sensor`

> **Safety**: Explicit sensor mapping tidak akan overwrite oleh auto-refresh. Sensor yang dipilih tetap menjadi primary hingga dilakukan remap.

## Monitoring Flow

```text
Customer Registry
         ↓
Monitoring Scope
         │
         ├── PRTG (📡)
         │      ↓
         │   Mapping required
         │      ↓
         │   Primary Sensor
         │      ↓
         │   PRTG API Observation
         │      ↓
         │   Backend: PRTG SENSOR
         │
         ├── NOT IN PRTG (🚫)
         │      ↓
         │   No PRTG mapping required
         │      ↓
         │   Direct ICMP Ping
         │      ↓
         │   Backend: DIRECT ICMP PING
         │
         └── PIC MANAGED (👤)
                ↓
            Not monitored by this bot
            Backend: None
```

### Device Mapping vs Explicit Sensor Mapping

**Device mapping** (`/map_client`): Customer dihubungkan ke PRTG device, primary sensor dipilih otomatis (biasanya Ping).

Gunakan device mapping ketika customer memiliki dedicated PRTG device.

**Explicit sensor mapping** (`/map_sensor`): Customer dihubungkan ke sensor spesifik di dalam shared device.

Gunakan sensor mapping ketika customer berada pada shared/aggregation router.

---

## Monitoring

### Startup Banner

Bot menampilkan ringkasan klasifikasi saat startup:

```
========================================
     PRTG TELEGRAM MONITOR
========================================

Environment       : production
Database          : /data/prtg_bot.db

[STARTUP] Customers: 23
[STARTUP] Active PRTG: 16
[STARTUP] Direct Ping: 2
[STARTUP] Paused: 2
[STARTUP] Unresolved: 1
[STARTUP] PIC Managed: 2

Poll interval     : 30s
DOWN confirm      : 2 polls
Recovery confirm  : 2 polls

Alerts            : ENABLED
Telegram target   : configured

========================================
```

### Health Check

Gunakan `/health` untuk melihat status bot:

```text
🩺 BOT HEALTH

🤖 Telegram
✅ Connected

📡 PRTG API
✅ Healthy

🌐 Direct Ping
✅ Healthy

🗄 Database
✅ Healthy

⚙️ Monitoring Engine
✅ Running

━━━━━━━━━━━━━━━━━━━━

📊 Monitoring

PRTG Targets
16
Ping Targets
2
Total Active
18

━━━━━━━━━━━━━━━━━━━━

⏸ Paused
2
🧩 Unresolved
1
👤 PIC Managed
2

━━━━━━━━━━━━━━━━━━━━

🔔 Alerts
✅ ENABLED

⏱ Poll Interval
30 seconds

🔄 Last Cycle
06 Sept 2026 • 18:16 WITA

⏱ Duration
21.1 s
```

### Test Alert

Gunakan `/test_alert` untuk memverifikasi Telegram notification delivery tanpa memodifikasi monitoring state.

---

## Backup

### Manual Backup

```bash
npm run backup
```

Backup disimpan di direktori `backups/` dengan format:

```
prtg_bot_2026-08-31_170000.db
```

### Retention

Backup otomatis menyimpan 7 backup terbaru. Backup lama akan dihapus otomatis.

### Restore

1. Stop container: `docker compose stop`
2. Backup database saat ini
3. Restore dari backup yang diinginkan
4. Start container: `docker compose start`
5. Verifikasi dengan `/health`

---

## Troubleshooting

### Telegram timeout

Periksa:
- Internet connection
- DNS resolution
- IPv4 connectivity
- `api.telegram.org` reachability

### PRTG timeout

Periksa:
- PRTG server reachable dari container
- Office LAN/VPN connectivity
- PRTG credentials benar
- PRTG certificate (self-signed sudah di-handle)

### Customer unmapped

Gunakan `/mapping <id>` untuk melihat status mapping.

Periksa juga monitoring scope dengan `/client <id>` — customer dengan scope `NOT IN PRTG` atau `PIC MANAGED` sengaja tidak dimonitor.

Jangan manual mark sebagai DOWN.

### Container stopped

```bash
docker compose ps
docker compose logs --tail=100 prtg-bot
```

---

## Security

- `.env` tidak boleh di-commit ke repository
- Telegram token harus dilindungi
- PRTG passhash harus dilindungi
- Admin IDs harus direview secara berkala
- Docker host access harus dibatasi
- Backup mengandung data operasional/customer

---

## Telegram Group Segmentation (V8.4, V8.5, V8.6)

`/status` and `/clients` (without client ID) are **context-aware**:

| Command | Private admin chat | Registered Telegram group | Unregistered Telegram group |
|---------|-------------------|--------------------------|----------------------------|
| `/status` | Global monitoring view — all customers | Only customers assigned to that group with `can_view = 1` | Denied — no customer data shown |
| `/clients` | Global client list — all customers | Only assigned customers with `can_view = 1` | Denied — no customer data shown |

Group assignment is a **presentation filter only**. The monitoring engine, alert routing, and data store remain global.

### Group `/status` Output

In a registered group, `/status` shows:

```text
📊 MONITORING STATUS

Telegram Group
NOC MOROWALI

━━━━━━━━━━━━━━━━━━

#2 SINAR TERANG MANDIRI
🟢 UP • 📡 PRTG

#4 AQUILA COBALT NICKEL
⏸ PAUSED • 📡 PRTG

━━━━━━━━━━━━━━━━━━

📈 SUMMARY

🟢 UP         : 2
🔴 DOWN       : 0
...
Assigned      : 4

🕒 09 Sep 2026 • 13:20 WITA
```

### Critical Security Rule

Unregistered groups receive **zero customer data** — the bot replies with "GROUP NOT REGISTERED" and never falls back to global status.

### Operator Workflow

1. Add bot to Telegram group as admin.
2. Admin runs `/register_group` in the group.
3. Admin assigns clients: `/assign_group <client_id>`.
4. Admin configures alert delivery per customer: `/group_alerts <client_id> on` (or `off`).
5. Admin verifies: `/group_clients`.
6. Anyone in the group runs `/status` or `/clients` → only assigned customers are shown.

### Group Alert Routing (V8.6)

When a customer transitions DOWN or RECOVERED, the bot sends alerts to all assigned Telegram groups where `receive_alerts = 1` (plus the existing global admin recipient). This is independent of `can_view` — `can_view` controls command visibility, `receive_alerts` controls alert delivery.

Toggling alert delivery to a group:
```
/group_alerts <client_id> on
/group_alerts <client_id> off
```

In `/group_clients`, each customer shows:
```
🔔 Alerts: ON   (receive_alerts = 1)
🔕 Alerts: OFF (receive_alerts = 0)
```

---

## Documentation

| File | Purpose |
|------|---------|
| [README.md](README.md) | Technical overview and installation guide |
| [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) | Status meanings, scopes, classifications, commands |
| [SOP_OPERATOR.md](SOP_OPERATOR.md) | Step-by-step operational procedures |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common error diagnosis and fixes |
| [.env.example](.env.example) | Template for configuration

---

## Production Activation

1. Pastikan `.env` sudah dikonfigurasi
2. Start container: `docker compose up -d`
3. Verifikasi dengan `/start`
4. Cek health: `/health`
5. Review mapping: `/mapping`
6. Review status: `/status`
7. Test alert: `/test_alert`
8. Monitor logs untuk beberapa cycle
9. Setelah yakin semua OK, edit `.env`: `ALERTS_ENABLED=true`
10. Restart: `docker compose restart`

---

## License

ISC