# PRTG Telegram Monitoring Bot — V7

## Production Operations & Handover

## 1. Objective

Prepare the bot for real operational use and handover.

V7 focuses on:

```text
production readiness
deployment reproducibility
security
backup and restore
alert validation
operator SOP
incident handling
handover
```

Do NOT add new monitoring features unless required to fix a production blocker.

---

# 2. Current Stable Baseline

Current V6.x capabilities:

```text
✅ Customer registry
✅ PRTG monitoring
✅ Direct ICMP fallback
✅ Monitoring scopes
✅ Automatic mapping
✅ Manual mapping
✅ Explicit sensor mapping
✅ Deep PRTG search
✅ DOWN confirmation
✅ RECOVERY confirmation
✅ Flap protection
✅ Telegram admin authorization
✅ SQLite persistence
✅ Docker deployment
✅ Backup / restore scripts
✅ Centralized classification
✅ Design B — Operator Card
✅ Centralized Telegram UI
```

Current classifications:

```text
active_prtg
active_icmp
paused_prtg
unresolved_prtg
pic_managed
disabled
```

Only:

```text
active_prtg
active_icmp
```

are alert eligible.

---

# 3. Feature Freeze

V6.x is considered feature-complete.

During V7:

Do NOT add:

```text
new protocols
new monitoring backends
web dashboard
Grafana
automatic fuzzy mapping
Excel sync
new database engine
new notification platform
```

Allowed changes:

```text
bug fixes
security fixes
deployment fixes
documentation
logging improvements
operational safeguards
```

---

# 4. Production Goal

At the end of V7, another operator should be able to:

```text
1. deploy the bot
2. configure secrets
3. start the service
4. verify monitoring
5. understand alerts
6. add/edit customers
7. troubleshoot common errors
8. create backups
9. restore the database
10. safely hand over responsibility
```

without needing the original developer present.

---

# 5. V7 Workstreams

V7 is divided into:

```text
V7.1  Production Configuration Audit
V7.2  Security Hardening
V7.3  Backup & Restore Drill
V7.4  Clean Deployment Test
V7.5  Monitoring & Alert Simulation
V7.6  Operational Logging & Health
V7.7  Operator SOP
V7.8  Troubleshooting Guide
V7.9  Handover Package
V7.10 Final Acceptance
```

---

# V7.1 — Production Configuration Audit

## 6. Audit `.env`

Review all required configuration.

Expected categories:

```text
Telegram
PRTG
Database
Monitoring
Direct Ping
Alerting
Timezone
```

Ensure `.env.example` contains every required variable.

Do NOT include real secrets in `.env.example`.

---

## 7. Required Environment Variables

Audit actual project variables and document them.

Example categories:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_IDS=

PRTG_BASE_URL=
PRTG_USERNAME=
PRTG_PASSHASH=

DATABASE_PATH=/data/prtg_bot.db

POLL_INTERVAL=30
DOWN_CONFIRM_COUNT=2
RECOVERY_CONFIRM_COUNT=2

ALERTS_ENABLED=true
DEBUG_MONITORING=false

DIRECT_PING_ENABLED=true
DIRECT_PING_COUNT=3
DIRECT_PING_TIMEOUT=3
DIRECT_PING_CONCURRENCY=8

TZ=Asia/Makassar
```

Use actual variable names from codebase.

Do not rename working variables unnecessarily.

---

## 8. Environment Validation

Startup should validate required environment variables.

Missing critical values should produce a clear startup error.

Example:

```text
[CONFIG] Missing required environment variable: TELEGRAM_BOT_TOKEN
```

Do not print actual secret values.

---

# V7.2 — Security Hardening

## 9. Secret Protection

Verify:

```text
.env
*.backup
database backups
credential files
```

are excluded from Git.

Check:

```bash
git status
git ls-files
```

Ensure secrets are not tracked.

---

## 10. `.gitignore`

Must include at least:

```text
.env
data/
backups/
*.db
*.sqlite
*.sqlite3
*.backup
```

Adjust based on actual project layout.

---

## 11. Docker Image Security

Verify runtime container:

```text
does not include .env
does not include backups
does not include unnecessary development files
```

Review `.dockerignore`.

---

## 12. PRTG TLS Exception

Current self-signed certificate exception must remain scoped only to PRTG.

Do NOT globally disable TLS verification.

Telegram HTTPS must use normal certificate verification.

---

## 13. Telegram Authorization

Verify all privileged commands remain admin-only:

```text
/add_client
/remove_client
/enable_client
/disable_client

/find_prtg
/find_prtg_deep
/find_prtg_sensor
/prtg_device
/prtg_sensor

/map_client
/map_sensor
/unmap_client

/set_scope

/test_alert
```

Adjust to actual authorization policy.

---

## 14. No Secret Logging

Search logs/code for:

```text
Telegram token
PRTG passhash
password
authorization headers
full secret URLs
```

Never log them.

---

## 15. Direct Ping Security

Preserve:

```text
spawn / execFile
no shell interpolation
NET_RAW only
```

Do NOT use:

```text
privileged: true
NET_ADMIN
host network
```

unless absolutely required.

---

# V7.3 — Backup & Restore Drill

## 16. Production Backup

Run:

```bash
docker compose exec prtg-bot npm run backup
```

Verify backup file is created.

Verify file is non-empty.

---

## 17. Backup Naming

Prefer timestamps:

```text
prtg-bot-2026-09-08T162500.db
```

or current established format.

---

## 18. Backup Contents

Backup must preserve:

```text
customers
monitoring scopes
PRTG mappings
sensor mappings
monitoring state
manual mappings
```

---

## 19. Restore Drill

Do not test restore against the only production database.

Create an isolated test environment.

Recommended workflow:

```text
production backup
        ↓
temporary test database
        ↓
restore script
        ↓
validation
```

---

## 20. Restore Validation

After restore verify:

```text
customer count
scope counts
mapping count
sensor mapping count
```

Expected current baseline:

```text
Customers = 23
```

Classification currently:

```text
active_prtg      = 16
active_icmp      = 2
paused_prtg      = 2
unresolved_prtg  = 1
pic_managed      = 2
disabled         = 0
```

Do not hardcode these values into runtime logic.

They are current acceptance values only.

---

## 21. Restore Documentation

Document:

```text
how to stop bot
how to locate backup
how to restore
how to restart
how to verify
```

---

# V7.4 — Clean Deployment Test

## 22. Clean Host Test

Test deployment on a clean Linux host or clean VM if available.

The machine should not depend on the developer environment.

Required host dependencies should ideally be only:

```text
Docker
Docker Compose
network access
```

---

## 23. Clean Deployment Procedure

Validate:

```bash
git clone ...
cd prtg_telegram_bot
cp .env.example .env
nano .env
docker compose build
docker compose up -d
```

Then restore/import database according to SOP.

---

## 24. No Hidden Dependencies

Ensure deployment does not depend on:

```text
local Node.js installation
local npm packages
developer home directory
hardcoded absolute paths
VSCode
Kilo CLI
```

---

## 25. Persistent Storage

Confirm database lives in persistent storage:

```text
/data/prtg_bot.db
```

inside the container.

Verify Docker volume survives:

```bash
docker compose down
docker compose up -d
```

Never use:

```bash
docker compose down -v
```

in normal operations.

---

## 26. Restart Test

Test:

```bash
docker compose restart prtg-bot
```

Verify:

```text
customer data intact
mappings intact
scope intact
monitoring resumes
Telegram reconnects
```

---

## 27. Host Reboot Test

If possible, reboot test host.

Verify Docker restart policy starts bot automatically.

Expected:

```text
restart: unless-stopped
```

or equivalent.

---

# V7.5 — Monitoring & Alert Simulation

## 28. Alert Test Philosophy

Do NOT disrupt real customer links to test alerts.

Use:

```text
/test_alert
controlled test customer
temporary test target
isolated simulation
```

---

## 29. Telegram Delivery Test

Run:

```text
/test_alert
```

Expected Design B output:

```text
🧪 TEST NOTIFICATION

Telegram alert delivery is working.

━━━━━━━━━━━━━━━━━━

This is NOT a real customer incident.
No monitoring state was changed.

✅ Delivery successful
```

---

## 30. PRTG DOWN Simulation

Use a safe test mapping/customer if available.

Validate:

```text
baseline
first failed poll
DOWN confirmation threshold
DOWN alert
continued DOWN no duplicate alert
recovery threshold
RECOVERY alert
```

---

## 31. ICMP DOWN Simulation

Use a safe temporary test IP/customer.

Validate:

```text
UP baseline
packet loss
DOWN_CONFIRM_COUNT
DOWN alert
no duplicate alert
RECOVERY_CONFIRM_COUNT
RECOVERY alert
```

---

## 32. Baseline Behavior

First observation must not generate false alert.

Example:

```text
no previous state
first state = DOWN
```

Follow current transition design.

Do not change existing semantics during V7 unless confirmed broken.

---

## 33. Flap Test

Simulate:

```text
UP
DOWN
UP
DOWN
```

before confirmation thresholds.

Expected:

```text
no false DOWN notification
no false RECOVERY notification
```

---

## 34. Non-Alert Classification Test

Explicitly validate:

```text
paused_prtg
unresolved_prtg
pic_managed
disabled
```

do NOT produce customer DOWN notifications.

---

## 35. Current Non-Active Examples

Acceptance examples:

```text
#4  AQUILA COBALT NICKEL
→ paused_prtg

#8  ANUGRAH AUTO SERVIS
→ unresolved_prtg

#17 UMI LINK LA
→ paused_prtg

#18 UMI LINK IOH
→ pic_managed

#19 UMI LINK TELKOM
→ pic_managed
```

Do not hardcode IDs into production logic.

---

# V7.6 — Operational Logging & Health

## 36. Startup Logging

Startup logs should include useful operational information.

Example:

```text
[STARTUP] Telegram bot initialized
[STARTUP] Database connected
[STARTUP] Customers: 23
[STARTUP] Active PRTG: 16
[STARTUP] Direct Ping: 2
[STARTUP] Paused: 2
[STARTUP] Unresolved: 1
[STARTUP] PIC Managed: 2
[STARTUP] Monitoring started
```

Never include secrets.

---

## 37. Monitoring Cycle Logs

Production logs should remain concise.

Example:

```text
[MONITOR] PRTG: 16 | UP: 16 | DOWN: 0 | UNKNOWN: 0
[MONITOR] DIRECT PING: 2 | UP: 2 | DOWN: 0 | UNKNOWN: 0
[MONITOR] TOTAL: 18 | UP: 18 | DOWN: 0 | UNKNOWN: 0
```

---

## 38. Error Logging

Errors should include:

```text
timestamp
module
customer/client_id if relevant
backend
error type
```

but not credentials.

---

## 39. Docker Log Rotation

Verify Compose config has log rotation.

Recommended:

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Use existing values if already configured.

---

## 40. `/health`

Verify Design B health output remains operational.

It should answer:

```text
Telegram healthy?
PRTG reachable?
Direct ping engine healthy?
Database healthy?
Monitoring engine running?
Last cycle?
```

---

## 41. Health Semantics

Do not mark bot unhealthy merely because:

```text
paused_prtg exists
unresolved customer exists
pic_managed exists
```

Those are customer classifications, not necessarily system failures.

---

# V7.7 — Operator SOP

## 42. Create Operator SOP

Create:

```text
SOP_OPERATOR.md
```

Keep it practical.

---

## 43. SOP — Daily Check

Document routine:

```text
1. open Telegram
2. run /health
3. run /status
4. inspect DOWN/WARNING/UNKNOWN
5. check unresolved if needed
```

---

## 44. SOP — When DOWN Alert Arrives

Recommended workflow:

```text
1. identify customer
2. identify backend
3. check /status <id>
4. if PRTG, verify PRTG status
5. if ICMP, verify network reachability
6. check whether issue is known
7. escalate according to office procedure
8. wait for RECOVERY alert
```

Do not invent company-specific escalation contacts.

Leave placeholders if needed.

---

## 45. SOP — Unresolved Customer

Document:

```text
/status <id>
/mapping <id>

/find_prtg ...
/find_prtg_deep ...

manual validation

/map_client ...
or
/map_sensor ...
```

Never tell operator to treat unresolved as DOWN.

---

## 46. SOP — Paused Customer

Explain:

```text
PAUSED ≠ DOWN
```

Operator should verify PRTG if pause is unexpected.

Bot should not send DOWN alert while paused.

---

## 47. SOP — PIC Managed

Explain:

```text
outside bot monitoring responsibility
```

Do not attempt to "fix" by mapping it automatically.

---

## 48. SOP — Direct Ping Customer

Explain:

```text
temporary/fallback monitoring
```

When customer is later added to PRTG:

```text
1. verify PRTG object
2. set scope to prtg
3. map device/sensor
4. verify /status
5. confirm direct ping stops
```

---

## 49. SOP — Adding Customer

Document:

```text
/add_client
```

with expected fields:

```text
name
IP
location
service ID
description
scope
```

---

## 50. SOP — Removing Customer

Document confirmation flow.

Warn operator that removal may delete related mapping/state according to database cascade behavior.

---

## 51. SOP — Enable / Disable

Explain difference:

```text
disabled
≠
paused
```

Disabled means bot ignores customer.

Paused means PRTG target exists but sensors are paused.

---

## 52. SOP — Mapping

Explain:

```text
automatic mapping
manual device mapping
explicit sensor mapping
```

Recommended hierarchy:

```text
explicit sensor
>
manual auto-primary
>
automatic
```

---

# V7.8 — Troubleshooting Guide

## 53. Create Troubleshooting File

Create:

```text
TROUBLESHOOTING.md
```

---

## 54. Telegram Bot Not Responding

Checklist:

```bash
docker compose ps
docker compose logs --tail=100 prtg-bot
```

Check:

```text
Telegram token
internet connectivity
DNS
Telegram API errors
authorization
```

Preserve IPv4-first Telegram networking workaround if required.

---

## 55. PRTG API Error

Checklist:

```text
office Wi-Fi connectivity
PRTG address reachable
credentials/passhash
TLS/self-signed handling
API timeout
PRTG server health
```

---

## 56. Direct Ping Error

Checklist:

```text
DIRECT_PING_ENABLED
valid IP
container NET_RAW capability
iputils-ping installed
host routing
firewall
```

---

## 57. Customer Shows UNKNOWN

Explain:

UNKNOWN should only mean:

```text
active monitoring backend failed to determine state
```

Check:

```text
PRTG API error
missing live result
ping execution failure
backend runtime issue
```

Do not confuse with:

```text
UNRESOLVED
PAUSED
PIC MANAGED
DISABLED
```

---

## 58. Customer Shows UNRESOLVED

Check:

```text
scope = prtg
mapping_status
device ObjID
sensor mapping
PRTG search
```

---

## 59. Customer Shows PAUSED

Check PRTG sensor/device parent.

Do not manually force DOWN.

---

## 60. Database Error

Checklist:

```text
/data mounted
file exists
permissions
disk space
SQLite integrity
backup availability
```

Optional safe integrity check:

```bash
sqlite3 /data/prtg_bot.db "PRAGMA integrity_check;"
```

Only if sqlite CLI exists.

Otherwise use Node/better-sqlite3.

---

## 61. Docker Problems

Document:

```bash
docker compose ps
docker compose logs
docker compose restart prtg-bot
docker compose up -d
```

Warn:

```text
DO NOT run docker compose down -v
```

unless intentionally destroying persistent data.

---

# V7.9 — Handover Package

## 62. Required Handover Files

Project should contain:

```text
README.md
OPERATOR_GUIDE.md
SOP_OPERATOR.md
TROUBLESHOOTING.md
.env.example
compose.yaml
Dockerfile
backup/restore scripts
```

Optional:

```text
CHANGELOG.md
DEPLOYMENT.md
```

---

## 63. README Role

README should be technical overview:

```text
architecture
requirements
deployment
commands
configuration
Docker
database
backup
```

---

## 64. Operator Guide Role

OPERATOR_GUIDE should explain:

```text
status meanings
scope meanings
mapping concepts
Telegram commands
classification semantics
```

---

## 65. SOP Role

SOP_OPERATOR should be:

```text
step-by-step operational procedure
```

not architecture documentation.

---

## 66. Troubleshooting Role

TROUBLESHOOTING should answer:

```text
what to do when something fails
```

---

## 67. Credential Handover

Do NOT place real credentials in documentation.

Provide:

```text
.env.example
```

Actual credentials should be transferred through the office's approved secure method.

---

## 68. Ownership Handover

Document:

```text
who owns the deployment
where it runs
where database lives
where backup lives
who receives alerts
```

Use placeholders if actual ownership details are not yet known.

---

# V7.10 — Final Acceptance

## 69. Docker Acceptance

Must pass:

```bash
docker compose build
docker compose up -d
docker compose ps
```

Container must remain healthy/running.

---

## 70. Syntax Acceptance

All JS:

```bash
find src scripts -name '*.js' -print0 | xargs -0 -n1 node -c
```

or equivalent.

---

## 71. Data Acceptance

Verify:

```text
customers intact
mappings intact
scopes intact
monitoring state intact
```

Current customer count:

```text
23
```

---

## 72. Classification Acceptance

Current expected:

```text
active_prtg       = 16
active_icmp       = 2
paused_prtg       = 2
unresolved_prtg   = 1
pic_managed       = 2
disabled          = 0

total             = 23
```

---

## 73. Telegram Acceptance

Verify:

```text
/start
/help
/status
/health
/clients
/mapping
```

and representative detail commands:

```text
/status 4
/status 8
/status 11
/status 17
/status 18
/status 21

/client 4
/client 17
/client 21

/mapping 4
/mapping 8
/mapping 11
/mapping 18
```

---

## 74. Alert Acceptance

Verify:

```text
/test_alert
controlled DOWN
no duplicate DOWN
controlled RECOVERY
no false alerts for non-active classifications
```

---

## 75. Backup Acceptance

Verify:

```text
backup succeeds
backup file readable
restore succeeds in isolated test
restored customer count correct
```

---

## 76. Restart Acceptance

Test:

```text
container restart
compose restart
host reboot if possible
```

Monitoring must resume automatically.

---

## 77. Timezone Acceptance

Inside container:

```bash
docker compose exec prtg-bot sh -c 'echo $TZ && date'
```

Expected:

```text
Asia/Makassar
```

Telegram timestamps:

```text
WITA
```

---

# 78. Production Observation Period

After deployment, observe actual runtime.

Focus on:

```text
PRTG API stability
Telegram stability
ICMP behavior
memory usage
CPU usage
database growth
log growth
false alerts
missed alerts
restart behavior
```

Do not introduce code changes unless a real issue is observed.

---

# 79. Observation Checklist

Periodically check:

```bash
docker compose ps
docker stats --no-stream
docker compose logs --tail=100 prtg-bot
```

and Telegram:

```text
/health
/status
```

---

# 80. Production Incident Rule

During observation:

```text
bug
→ reproduce
→ document
→ fix narrowly
→ regression test
```

Do not reopen broad feature development.

---

# 81. Optional Version Tag

After final acceptance, create a stable release/tag if Git workflow is used.

Example:

```text
v7.0.0
```

Only after acceptance completes.

Do not commit `.env` or real credentials.

---

# 82. Final Handover Checklist

Before handover:

```text
✅ project builds cleanly
✅ container starts automatically
✅ database persistent
✅ backup verified
✅ restore verified
✅ Telegram works
✅ PRTG works
✅ Direct Ping works
✅ alert confirmation works
✅ recovery works
✅ no false alert from paused
✅ no false alert from unresolved
✅ no false alert from PIC Managed
✅ no false alert from disabled
✅ Design B consistent
✅ timezone WITA
✅ secrets protected
✅ docs complete
✅ SOP complete
✅ troubleshooting complete
✅ operator can deploy
✅ operator can recover
✅ operator understands classifications
```

---

# 83. Definition of Done

V7 is complete when the project can be handed to another operator who can operate and recover it without needing the original developer.

The handover must demonstrate:

```text
DEPLOY
   ↓
CONFIGURE
   ↓
START
   ↓
VERIFY
   ↓
MONITOR
   ↓
RESPOND
   ↓
BACKUP
   ↓
RESTORE
```

successfully.

---

# 84. Final Product Boundary

The bot is responsible for:

```text
customer registry
PRTG customer monitoring
direct ICMP fallback
Telegram status
Telegram alerts
mapping administration
operator visibility
```

The bot is NOT responsible for:

```text
repairing customer links
changing PRTG configuration automatically
restarting network devices
making routing changes
monitoring PIC-managed links
replacing PRTG itself
```

---

# 85. Immediate Agent Task

Start V7 implementation in this order:

```text
1. Audit production configuration.
2. Audit .env.example.
3. Audit .gitignore and .dockerignore.
4. Audit secret handling.
5. Audit Telegram authorization.
6. Audit Docker persistence.
7. Verify backup command.
8. Perform isolated restore drill.
9. Verify clean deployment procedure.
10. Verify restart behavior.
11. Verify timezone.
12. Validate /health.
13. Run Telegram Design B regression.
14. Run alert test.
15. Verify alert eligibility.
16. Create SOP_OPERATOR.md.
17. Create TROUBLESHOOTING.md.
18. Update README.md.
19. Update OPERATOR_GUIDE.md.
20. Produce final handover checklist.
21. Run complete acceptance test.
```

---

# 86. V7 Success State

When completed:

```text
V6.x
FEATURE DEVELOPMENT
✅ COMPLETE
🔒 FROZEN

V7
PRODUCTION OPERATIONS
✅ VALIDATED

HANDOVER
✅ READY
```
