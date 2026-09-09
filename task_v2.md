# PRTG Telegram Monitoring Bot — Task Guide V2

## 1. Project Objective

Build a portable **PRTG Monitoring Telegram Bot** using Node.js.

The application will be handed to an employee at the internship/workplace.

Primary requirements:

- Monitor ONLY customers explicitly registered in the application's SQLite registry.
- Never expose or alert on unrelated PRTG customers.
- Manage customers from Telegram.
- Restrict customer mutations to authorized Telegram admins.
- Map registered customers to their PRTG devices/sensors.
- Select appropriate active sensors for monitoring.
- Track state changes:
  - UP -> DOWN
  - DOWN -> UP
- Send Telegram alerts only for registered and validly mapped customers.
- Package the application with Docker for deployment on another host.
- Keep all secrets in `.env`.

---

## 2. Current Technology Stack

Current stack:

```text
Node.js 22
Telegraf 4.16.3
node-fetch 2.7.0
axios
better-sqlite3
dotenv
SQLite
Docker (planned)
```

---

## 3. Current Project Structure

Expected structure:

```text
prtg_telegram_bot/
├── src/
│   ├── config/
│   │   └── env.js
│   ├── database/
│   │   ├── database.js
│   │   ├── init.js
│   │   ├── seed.js
│   │   └── customers.js
│   ├── monitoring/
│   ├── prtg/
│   │   ├── client.js
│   │   ├── parser.js
│   │   ├── mapper.js
│   │   └── mapping-report.txt
│   └── telegram/
│       ├── bot.js
│       ├── auth.js
│       ├── commands.js
│       ├── customer-commands.js
│       ├── add-client.js
│       └── validators.js
├── data/
│   └── prtg_bot.db
├── .env
├── .gitignore
├── package.json
└── package-lock.json
```

Preserve working modules unless a refactor is necessary.

---

## 4. Security Requirements

### PRTG credentials

Never hardcode:

```text
PRTG_USERNAME
PRTG_PASSHASH
```

Use:

```env
PRTG_URL=https://182.23.6.54
PRTG_USERNAME=...
PRTG_PASSHASH=...
```

Never log credentials.

The PRTG passhash previously exposed during development should be rotated.

### Telegram credentials

Use:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_ADMIN_IDS=...
```

Never log the Telegram token.

The Telegram token previously exposed during development should be revoked and replaced.

### Git

`.gitignore` must include:

```gitignore
node_modules/
.env
data/*.db
data/*.db-shm
data/*.db-wal
*.log
```

---

## 5. Telegram IPv4 Requirement

The workplace network advertises IPv6 but does not have a working IPv6 route.

Observed behavior:

```text
curl -> Telegram API                      OK
Node fetch default                     ETIMEDOUT
Node fetch + ipv4first                    OK
node-fetch + https.Agent({ family: 4 }) OK
```

Keep:

```js
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
```

and:

```js
const https = require("https");

const ipv4Agent = new https.Agent({
    family: 4,
    keepAlive: true
});
```

Do not remove the IPv4 workaround unless a replacement is tested.

---

## 6. Customer Registry

SQLite is the source of truth for which customers may be monitored.

The bot MUST NOT monitor arbitrary PRTG devices outside the registry.

Initial real customer registry contains 23 customers:

```text
1. RS UNIVERSITAS HASANUDDIN
   IP: 183.91.66.98
   Location: Makassar
   Service ID: 2023347917
   Service: MAIN LINK

2. SINAR TERANG MANDIRI
   IP: 103.169.22.218
   Location: Morowali
   Service ID: 2021289586
   Service: MAIN LINK

3. TAMACO GRAHA KRIDA
   IP: 36.37.115.154
   Location: Morowali
   Service ID: 2024416607
   Service: MAIN LINK

4. AQUILA COBALT NICKEL
   IP: 103.191.8.70
   Location: Morowali
   Service ID: 2023392903
   Service: MAIN LINK

5. METAL SMELTINDO SELARAS
   IP: 182.23.13.74
   Location: Morowali
   Service ID: 2024422995
   Service: MAIN LINK

6. METAL SMELTINDO SELARAS
   IP: 182.23.40.250
   Location: Morowali
   Service ID: 2025492539
   Service: BACKUP LINK

7. TEKNIK ALUM SERVICE
   IP: 123.231.219.2
   Location: Morowali
   Service ID: 2021255850
   Service: MAIN LINK

8. ANUGRAH AUTO SERVIS
   IP: 103.189.94.106
   Location: Morowali
   Service ID: 2022319993
   Service: MAIN LINK

9. BAHODOPI NICKEL SMELTING INDONESIA
   IP: 103.239.215.170
   Location: Morowali
   Service ID: 2026513717
   Service: MAIN LINK

10. META TELEKOMUNIKASI ASIA
    IP: 103.188.36.194
    Location: Morowali
    Service ID: 2024421449
    Service: MAIN LINK

11. HENGJAYA MINERALINDO
    IP: 123.231.218.198
    Location: Morowali
    Service ID: 2017004132
    Service: MAIN LINK

12. KANTOR OTBAN WILAYAH V
    IP: 182.23.13.82
    Location: Makassar
    Service ID: 2022300999
    Service: MAIN LINK

13. HONDA REMAJA JAYA
    IP: 182.23.11.50
    Location: Panaikang
    Service ID: 2023346550
    Service: MAIN LINK

14. SATUNOL DIGITAL TEKNOLOGI
    IP: 103.102.48.242
    Location: Pinrang
    Service ID: 2024418941
    Service: MAIN LINK

15. TRAVIRA AIR
    IP: 103.252.86.242
    Location: Jakarta
    Service ID: 2023356973
    Service: MAIN LINK

16. TRAVIRA AIR
    IP: 123.231.255.122
    Location: Jakarta
    Service ID: 2024430793
    Service: BACKUP LINK

17. UNIVERSITAS MUSLIM INDONESIA
    IP: 123.231.157.86
    Location: Makassar
    Service ID: 2022340441
    Service: LINK LA

18. UNIVERSITAS MUSLIM INDONESIA
    IP: 114.9.83.10
    Location: Makassar
    Service ID: NULL
    Service: LINK IOH

19. UNIVERSITAS MUSLIM INDONESIA
    IP: 36.64.252.26
    Location: Makassar
    Service ID: NULL
    Service: LINK TELKOM

20. SANATEL
    IP: 103.200.206.26
    Location: Gedung Cyber
    Service ID: 2023382881
    Service: MAIN LINK

21. CITRA CELEBAS MULTIMEDIA
    IP: 103.186.10.118
    Location: Pettarani
    Service ID: 2025499622
    Service: NAP 9 G

22. SANATEL
    IP: 123.231.137.158
    Location: Gedung Duren 3
    Service ID: 2025467765
    Service: Link NAP

23. EASTERN PEARL FLOUR MILLS
    IP: 182.23.68.242
    Location: Makassar
    Service ID: 2015004916
    Service: MAIN LINK
```

---

## 7. Client ID Policy

The table contains:

```text
id
client_id
name
ip
location
service_id
description
enabled
created_at
updated_at
```

### SQLite `id`

- Internal only.
- Never shown to Telegram users.
- Used internally for UPDATE/DELETE.

### `client_id`

- Customer-facing number.
- Sequential from `1..N`.
- `/clients` shows it.
- `/client <client_id>` uses it.
- `/remove_client <client_id>` uses it.
- `/enable_client <client_id>` uses it.
- `/disable_client <client_id>` uses it.
- After deleting a customer, reindex `client_id` to remove gaps.

Example:

```text
Before:
#1
#2
#3

Delete #2:

After:
#1
#2
```

The customer that was #3 becomes #2.

The SQLite `id` remains internal.

---

## 8. CRUD Status

Already implemented:

```text
/start
/help
/id
/chatid
/clients
/client <client_id>

/admin_test
/add_client
/remove_client <client_id>
/confirm_remove
/enable_client <client_id>
/disable_client <client_id>
/cancel
```

Admin authorization is based on:

```js
ctx.from.id
```

against:

```env
TELEGRAM_ADMIN_IDS=...
```

Do not authorize based only on Telegram username.

---

## 9. Add Client Flow

Current flow:

```text
/add_client
    ↓
Name
    ↓
IP
    ↓
Location
    ↓
Service ID
    ↓
Description / Service
    ↓
Confirmation
    ↓
/yes
```

`/cancel` cancels the active conversation.

Requirements:

- Valid name.
- Valid IPv4.
- No duplicate IP.
- Service ID may be omitted using `-`.
- Supplied Service ID must be validated.
- Duplicate Service ID should be rejected.
- Customer is persisted only after confirmation.
- New `client_id` follows current sequential registry.
- SQLite internal ID is not shown.

---

## 10. PRTG API Findings

Current PRTG:

```text
Version: 23.4.88.1429
Tree size: 8127
```

The response structure is unusual.

The large object collection was found under:

```js
data[""]
```

with numeric keys:

```text
"0"
"1"
"2"
...
```

Previous successful extraction:

```text
8127 objects
7302 useful objects
```

Parser must continue tolerating:

```text
data[""]
data["devices,sensors"]
data["devices%2Csensors"]
data["sensors"]
data["devices"]
```

Do not assume one fixed response key without testing.

---

## 11. PRTG Modules Already Implemented

### `src/prtg/client.js`

Uses axios.

Responsibilities:

- PRTG HTTP/API communication.
- Self-signed certificate support where required.
- Development timeout around 60 seconds.
- No credential logging.

Known exports:

```text
getApiInfo()
getSensors()
getDevices()
getTable()
```

### `src/prtg/parser.js`

Normalizes PRTG objects:

```js
{
    objid,
    parentid,
    type,
    device,
    sensor,
    host,
    status,
    lastvalue,
    group,
    probe,
    message
}
```

### `src/prtg/mapper.js`

Current approach:

1. Search by IP / host where possible.
2. Resolve device ObjID.
3. Fetch children/sensors by parent relationship.
4. Limited local search fallback.
5. Only consider registered customers.

Do not broaden to unrestricted fuzzy name matching.

---

## 12. Current Mapping Results

The full mapping report is:

```text
src/prtg/mapping-report.txt
```

Current results for real customers:

```text
18 / 23 mapped via Service ID
5 / 23 not found
```

A sixth not-found entry was:

```text
BANK PERINDO
IP: 10.1.1.5
```

This was explicitly a test customer added during development.

IMPORTANT:

```text
BANK PERINDO IS A TEST CUSTOMER.
```

Do not treat it as a production mapping failure.

---

## 13. Real Customers Not Currently Mapped

```text
1. UNIVERSITAS MUSLIM INDONESIA
   IP: 114.9.83.10
   Service ID: NULL
   Service: LINK IOH

2. UNIVERSITAS MUSLIM INDONESIA
   IP: 36.64.252.26
   Service ID: NULL
   Service: LINK TELKOM

3. SANATEL
   IP: 123.231.137.158
   Service ID: 2025467765
   Service: Link NAP

4. ANUGRAH AUTO SERVIS
   IP: 103.189.94.106
   Service ID: 2022319993
   Service: MAIN LINK

5. CITRA CELEBAS MULTIMEDIA
   IP: 103.186.10.118
   Service ID: 2025499622
   Service: NAP 9 G
```

These must not be classified as DOWN.

Use:

```text
mapping_status = unmapped
```

until verified.

---

## 14. Shared Device Finding

The previous report produced a "shared device" warning.

The warning was determined to be a false positive because multiple sensors belonged to the same customer's device.

No evidence currently shows one PRTG device being legitimately shared by unrelated customers.

Therefore:

```text
One customer -> one PRTG device -> many sensors
```

is valid.

Do not reject a mapping just because one device has many sensors.

---

## 15. Known Good PRTG Mapping

Customer:

```text
HENGJAYA MINERALINDO
Service ID: 2017004132
IP: 123.231.218.198
```

PRTG device:

```text
2017004132-HENGJAYA MINERALINDO MOROWALI
```

Sensors:

```text
3026  Ping
12844 WAN-INTERNET
12847 Uptime
13835 LAN TO HENGJAYA
```

Observed status:

```text
All Up
```

This is the canonical integration test customer.

---

## 16. Multi-Sensor Requirement

Some customers have many sensors.

Examples:

```text
UMI -> about 20 sensors
AQUILA -> about 7 sensors
```

Do not assume one customer has only one sensor.

Sensors may represent:

```text
Ping
WAN
LAN
Traffic
Uptime
CPU
Memory
System Health
...
```

Group sensors by their PRTG device.

---

## 17. New Current Milestone: Persistent Mapping Inventory

DO NOT IMPLEMENT CONTINUOUS MONITORING YET.

First build a persistent mapping inventory.

Target:

```text
Customer Registry
      ↓
PRTG Device(s)
      ↓
PRTG Sensor(s)
      ↓
Primary Sensor Selection
```

Each enabled customer should have:

```text
mapped
unmapped
ambiguous
```

Recommended object:

```js
{
    customerId,
    clientId,
    serviceId,
    ip,
    name,
    mappingStatus,

    devices: [
        {
            objid,
            device,
            host,
            group,
            probe,

            sensors: [
                {
                    objid,
                    name,
                    status,
                    lastvalue
                }
            ]
        }
    ],

    primarySensor: {
        objid,
        name
    },

    lastVerifiedAt
}
```

---

## 18. Recommended Mapping Tables

Inspect existing schema first.

Preferred normalized design:

```text
customers
    |
    +---< customer_prtg_devices
    |
    +---< customer_prtg_sensors
```

Possible tables:

```text
customer_prtg_devices
----------------------
id
customer_id
prtg_objid
device
host
group_name
probe
status
mapping_status
is_primary
last_verified_at
```

and:

```text
customer_prtg_sensors
---------------------
id
device_mapping_id
prtg_objid
sensor
status
lastvalue
sensor_type
is_primary
enabled
last_verified_at
```

Do not destroy or rewrite customer data.

If current implementation already contains mapping tables, inspect and improve them instead of replacing them blindly.

---

## 19. Sensor Selection Policy

Use a deterministic primary sensor selection policy.

Recommended preference:

```text
1. Ping
2. WAN / Internet sensor
3. Link / interface sensor
4. Uptime
5. Other health sensors
```

This is a preference, not a hard requirement.

Never choose these as primary:

```text
Paused
Paused (paused)
Paused (paused by parent)
```

A paused sensor does not imply customer DOWN.

Unknown/unmapped must not become DOWN.

---

## 20. Mapping Status Policy

Use:

```text
mapped
```

when a valid PRTG device/sensor relationship is confidently identified.

Use:

```text
ambiguous
```

when multiple unrelated candidates cannot be distinguished safely.

Use:

```text
unmapped
```

when no valid mapping can be found.

Never silently guess.

---

## 21. Customer State Policy for Later Monitoring

Do not implement continuous polling yet.

When monitoring is eventually implemented:

```text
Ping/primary sensor DOWN
    ↓
customer DOWN

Ping/primary sensor UP
    ↓
customer UP
```

Additional sensors may be:

```text
Warning
Unusual
```

without automatically changing customer state to DOWN.

Paused sensors are ignored for primary customer state.

Unmapped customers remain:

```text
UNMAPPED
```

not DOWN.

---

## 22. Mapping Inventory Telegram Command

Add an admin-only command:

```text
/discover_clients
```

or:

```text
/mapping
```

It should produce a summary such as:

```text
Total customers : 23
Mapped          : 18
Unmapped        : 5
Ambiguous       : 0
```

Example mapped result:

```text
#11 HENGJAYA MINERALINDO
Status: MAPPED

PRTG Device:
2017004132-HENGJAYA MINERALINDO MOROWALI

Primary:
🟢 Ping

Other sensors:
🟢 WAN-INTERNET
🟢 LAN TO HENGJAYA
🟢 Uptime
```

Example unresolved result:

```text
#22 SANATEL
Status: UNMAPPED

IP:
123.231.137.158

Service ID:
2025467765

Reason:
No verified PRTG mapping found.
```

Never expose unrelated PRTG customers.

---

## 23. Mapping Inventory Persistence

The mapping inventory should be persisted after validation.

Recommended stored information:

```text
customer
PRTG device
PRTG sensor
sensor status
primary sensor
mapping status
last verification time
```

Do not persist guessed/ambiguous mappings as if they were verified.

A later re-discovery should update existing mappings rather than create uncontrolled duplicates.

---

## 24. Validation Requirements

Before continuous monitoring:

### Customer scope

Every mapping must correspond to an explicitly registered customer.

### No unrelated devices

Never associate a PRTG device with a customer just because its name contains a common token like:

```text
UNIVERSITAS
KANTOR
JAYA
AUTO
```

### Multi-sensor grouping

Sensors must be grouped under their actual PRTG device.

### Primary sensor

Primary selection must be deterministic.

### Paused exclusion

Paused sensors are not eligible as primary.

### Unmapped handling

Unmapped is not DOWN.

### Test customer

BANK PERINDO remains test-only unless deliberately added again.

---

## 25. No Continuous Monitoring Yet

Do NOT implement:

```text
continuous polling
DOWN notification
RECOVERY notification
automatic Telegram alerts
```

until persistent mapping inventory is validated.

---

## 26. Later Monitoring State Tracking

Eventually:

```text
every 30 seconds
        ↓
registered + mapped customers
        ↓
read primary sensor
        ↓
compare previous state
        ↓
state changed?
       / \\
     YES  NO
      ↓    ↓
   Telegram ignore
```

Only state changes generate alerts.

```text
UP -> DOWN
```

send:

```text
🔴 CUSTOMER DOWN
```

```text
DOWN -> UP
```

send:

```text
🟢 CUSTOMER RECOVERY
```

Recommended states:

```text
UP
DOWN
WARNING
UNUSUAL
PAUSED
UNMAPPED
UNKNOWN
```

State tracking should eventually survive application restarts or reconstruct safely from current PRTG state.

---

## 27. Later `/status`

Eventually implement:

```text
/status
```

Example:

```text
📊 CUSTOMER STATUS

🟢 UP      : 18
🔴 DOWN    : 2
🟡 WARNING : 1
⚪ PAUSED  : 2

Total monitored: 23
```

And:

```text
/status 11
```

could show:

```text
🏢 HENGJAYA MINERALINDO

📍 Morowali
🔗 MAIN LINK

🟢 Status: UP
📡 Ping: 41 ms
```

Use `client_id` for lookup.

---

## 28. Recommended Alert Format

DOWN:

```text
🔴 CUSTOMER DOWN

🏢 HENGJAYA MINERALINDO
📍 Morowali

🔗 Service: MAIN LINK
🌐 IP: 123.231.218.198

📡 Status: DOWN
🕒 Detected: 10:32:17
```

RECOVERY:

```text
🟢 CUSTOMER RECOVERY

🏢 HENGJAYA MINERALINDO
📍 Morowali

🔗 Service: MAIN LINK
🌐 IP: 123.231.218.198

📡 Status: UP
🕒 Recovered: 10:35:42
```

Never expose unrelated customers.

---

## 29. Docker Goal

The final application must run on another host without changing source code.

Expected:

```text
Docker Container
    ├── Node.js
    ├── Telegraf
    ├── PRTG API client
    ├── Monitoring engine
    └── SQLite
           │
           ▼
     persistent volume
```

Recommended:

```text
/data/prtg_bot.db
```

Use a Docker volume.

Inject secrets through `.env`.

Do not bake secrets into image layers.

Use Node 22 slim initially because `better-sqlite3` is a native module.

---

## 30. Docker Files Later

Create later:

```text
Dockerfile
compose.yaml
.dockerignore
.env.example
README.md
```

README should explain:

```text
1. Create .env
2. Configure PRTG
3. Configure Telegram token
4. Configure admin IDs
5. docker compose up -d --build
6. docker compose logs -f
7. Use Telegram /start
```

---

## 31. Agent Operating Rules

### Before modifying code

1. Inspect current source tree.
2. Preserve working features.
3. Do not rewrite working modules unnecessarily.
4. Check installed package versions.
5. Make incremental changes.
6. Test every meaningful change.

### Database

1. Never destroy existing database automatically.
2. Use migrations.
3. Preserve customer data.
4. Verify row counts.
5. Avoid silently changing customer attributes.

### PRTG

1. Test API manually.
2. Verify exact response structure.
3. Do not assume standard JSON structure.
4. Never broaden customer scope.
5. Use HENGJAYA as canonical test.
6. Never treat unmapped as DOWN.

### Telegram

1. Preserve IPv4 workaround.
2. Never print tokens.
3. Keep admin authorization.
4. Do not break add-client conversation.
5. Keep CRUD operational.

---

## 32. Known Good Test Customer

Use:

```text
HENGJAYA MINERALINDO
IP: 123.231.218.198
Location: Morowali
Service ID: 2017004132
Service: MAIN LINK
```

Known PRTG device:

```text
2017004132-HENGJAYA MINERALINDO MOROWALI
```

Known sensors:

```text
Ping
WAN-INTERNET
LAN TO HENGJAYA
Uptime
```

Always look up the current `client_id` from SQLite; do not assume it remains 11 after customer reindexing/deletion.

---

## 33. Current Project Status

Completed:

```text
✅ Node.js project
✅ SQLite
✅ 23 initial real customers
✅ .env
✅ Telegram bot
✅ Telegraf
✅ IPv4 workaround
✅ Telegram polling
✅ /start
✅ /help
✅ /id
✅ /chatid
✅ Admin authorization
✅ /admin_test
✅ /clients
✅ /client
✅ /add_client
✅ /cancel
✅ /remove_client
✅ /enable_client
✅ /disable_client
✅ client_id migration
✅ client_id sequential reindexing
✅ PRTG HTTP client
✅ PRTG parser
✅ PRTG mapper
✅ Full mapping report
✅ 18/23 real customer Service ID mappings
```

Not completed:

```text
⬜ Persistent PRTG mapping inventory
⬜ Mapping database tables if needed
⬜ Sensor selection persistence
⬜ Admin /discover_clients or /mapping
⬜ Resolve/verify 5 unmapped customers
⬜ Monitoring state engine
⬜ State persistence
⬜ /status
⬜ DOWN alert
⬜ RECOVERY alert
⬜ Docker
⬜ README
```

---

## 34. Immediate Next Task for the Agent

The immediate task is:

> **Build and validate a persistent PRTG mapping inventory. Do NOT implement continuous monitoring yet.**

The agent must:

1. Inspect current `src/prtg/`.
2. Inspect current database schema.
3. Preserve all CRUD.
4. Map all enabled customers.
5. Use Service ID first.
6. Use IP second.
7. Group all sensors under the proper PRTG device.
8. Exclude paused sensors from primary selection.
9. Select one deterministic primary sensor.
10. Persist validated mappings.
11. Track `mapped`, `unmapped`, and `ambiguous`.
12. Add an admin-only `/discover_clients` or `/mapping` command.
13. Produce a readable mapping report.
14. Test HENGJAYA.
15. Treat BANK PERINDO as test-only.
16. Never classify unmapped as DOWN.
17. Never expose unrelated PRTG devices.
18. Do not start continuous monitoring.
19. Do not send automated alerts yet.

---

## 35. Definition of Done

This milestone is complete when:

```text
✅ Every enabled customer has a mapping status
✅ Mapped customers have verified PRTG device/sensor data
✅ Multi-sensor devices are grouped correctly
✅ Primary sensor selection is deterministic
✅ Paused sensors are excluded as primary
✅ Unmapped customers are not considered DOWN
✅ No unrelated PRTG customers are exposed
✅ HENGJAYA maps correctly
✅ Mapping results are persisted
✅ Admin mapping/discovery command works
✅ Existing CRUD still works
✅ No continuous monitoring is enabled
✅ No DOWN/RECOVERY alerts are sent yet
```
