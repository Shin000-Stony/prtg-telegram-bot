# PRTG Telegram Monitoring Bot — V8.6

## Group-Scoped Alert Routing & Operator Workflow

## 1. Objective

Implement customer-specific alert routing to Telegram groups.

Current V8 behavior:

```text
Private /status
→ GLOBAL

Private /clients
→ GLOBAL

Group /status
→ assigned customers only

Group /clients
→ assigned customers only

/group_clients
→ assigned customers only
```

V8.6 adds:

```text
Customer DOWN
→ alert sent to assigned Telegram group(s)

Customer RECOVERED
→ recovery sent to assigned Telegram group(s)
```

Only when:

```text
receive_alerts = 1
```

for that customer↔group assignment.

---

# 2. Core Rule

Telegram group assignment has two independent meanings:

```text
can_view
→ customer visible in group commands

receive_alerts
→ group receives customer alerts
```

Recommended default:

```text
can_view       = 1
receive_alerts = 1
```

---

# 3. Monitoring Engine Must Remain Global

Do NOT create separate monitoring loops per Telegram group.

Keep:

```text
PRTG + ICMP
     ↓
GLOBAL MONITORING ENGINE
     ↓
customer state transition
     ↓
NOTIFIER
     ↓
recipient routing
```

Only notifier recipient selection changes.

---

# 4. Alert Eligibility

Existing:

```js
isAlertEligible(classification)
```

must remain authoritative.

Only:

```text
active_prtg
active_icmp
```

are alert eligible.

Never send DOWN/RECOVERY for:

```text
paused_prtg
unresolved_prtg
pic_managed
disabled
```

---

# 5. Recipient Resolution

For every customer alert:

```text
customer
   ↓
customer_telegram_groups
   ↓
telegram_groups
   ↓
enabled group
   ↓
receive_alerts = 1
   ↓
Telegram chat_id
```

---

# 6. Repository Query

Use or add:

```text
getAlertRecipientsForCustomer(customerId)
```

Conceptual SQL:

```sql
SELECT DISTINCT
    tg.chat_id,
    tg.name
FROM customer_telegram_groups ctg
JOIN telegram_groups tg
    ON tg.id = ctg.telegram_group_id
WHERE ctg.customer_id = ?
  AND ctg.receive_alerts = 1
  AND tg.enabled = 1;
```

Use parameterized SQL.

---

# 7. Important FK Rule

Use internal:

```text
customers.id
```

for database relationships.

Do NOT use:

```text
client_id
```

as foreign key.

`client_id` remains operator-facing only.

---

# 8. Alert Recipient Deduplication

Before sending:

```text
deduplicate by Telegram chat_id
```

One Telegram chat must receive only one copy of one alert.

Even if duplicate routing path accidentally exists.

---

# 9. Global Admin Alerts

Preserve current global/admin notification behavior.

Recommended model:

```text
Customer alert
     │
     ├── existing global/admin recipient(s)
     │
     └── assigned group recipient(s)
```

Do NOT silently remove existing private/admin alerts.

If a global recipient chat ID is the same as a group recipient:

```text
send only once
```

---

# 10. No Group Assignment

If customer has no Telegram group assignment:

```text
monitoring continues
state transition continues
```

Existing global/admin alert behavior remains.

Do not suppress the existing notifier accidentally.

---

# 11. DOWN Flow

Expected:

```text
Customer #11
active_prtg

state:
UP → DOWN

DOWN_CONFIRM_COUNT reached
        ↓
transition confirmed
        ↓
notifier called
        ↓
global recipients
+
assigned group recipients
        ↓
Telegram delivery
```

---

# 12. RECOVERY Flow

Expected:

```text
Customer #11

DOWN → UP

RECOVERY_CONFIRM_COUNT reached
        ↓
recovery confirmed
        ↓
same routing system
        ↓
RECOVERY notification
```

---

# 13. Alert Assignment Example

Suppose:

```text
#11 HENGJAYA MINERALINDO
```

is assigned to:

```text
Tambang
receive_alerts = 1

Enterprise
receive_alerts = 1
```

On DOWN:

```text
Tambang
→ receives alert

Enterprise
→ receives alert

Global admin
→ receives existing alert
```

---

# 14. `receive_alerts = 0`

If:

```text
Tambang
can_view = 1
receive_alerts = 0
```

then:

```text
/status
→ customer visible

/clients
→ customer visible

DOWN
→ no Tambang alert
```

This distinction must work.

---

# 15. Group Alert Toggle

Add admin command:

```text
/group_alerts <client_id> on
/group_alerts <client_id> off
```

Must be run inside a registered group.

Examples:

```text
/group_alerts 11 on
/group_alerts 11 off
```

---

# 16. Alert Toggle Validation

Verify:

```text
admin authorized
group registered
customer exists
assignment exists
```

If customer not assigned:

```text
❌ CUSTOMER NOT ASSIGNED

Assign customer first:
/assign_group 11
```

---

# 17. Alert Toggle Success

Enable:

```text
✅ ALERT ROUTING UPDATED

#11 HENGJAYA MINERALINDO

Telegram Group
Tambang

━━━━━━━━━━━━━━━━━━

Visibility
✅ ENABLED

Alert Delivery
✅ ENABLED
```

Disable:

```text
✅ ALERT ROUTING UPDATED

#11 HENGJAYA MINERALINDO

Telegram Group
Tambang

━━━━━━━━━━━━━━━━━━

Visibility
✅ ENABLED

Alert Delivery
❌ DISABLED
```

---

# 18. `/group_clients` Enhancement

Show alert-routing state.

Example:

```text
👥 GROUP CUSTOMERS

Telegram Group
Tambang

━━━━━━━━━━━━━━━━━━

#2 SINAR TERANG MANDIRI
📡 PRTG • 🟢 UP
🔔 Alerts: ON

#4 AQUILA COBALT NICKEL
📡 PRTG • ⏸ PAUSED
🔔 Alerts: ON

#11 HENGJAYA MINERALINDO
📡 PRTG • 🟢 UP
🔕 Alerts: OFF

━━━━━━━━━━━━━━━━━━

Assigned Customers
3
```

---

# 19. `/clients` Group View

Optional minor enhancement:

Inside group:

```text
#11 HENGJAYA MINERALINDO
📡 PRTG • 🟢 UP • 🔔
```

or:

```text
📡 PRTG • 🟢 UP
```

Do not make `/clients` visually noisy.

`/group_clients` may remain the detailed assignment view.

---

# 20. `/status` Group View

Do NOT add alert-routing metadata to every row unless needed.

Keep `/status` focused on monitoring state.

---

# 21. Group Alert Status in `/group_clients`

Recommended labels:

```text
🔔 Alerts ON
🔕 Alerts OFF
```

Do not use:

```text
Disabled
```

alone, because that may be confused with disabled customer classification.

---

# 22. Group Disable Behavior

If:

```text
telegram_groups.enabled = 0
```

then:

```text
group commands
→ unavailable

group alerts
→ not sent
```

Assignments remain stored.

---

# 23. Unregister Behavior

When group is removed:

```text
customer_telegram_groups
→ cascade deleted
```

Future alerts must stop automatically.

Global monitoring continues.

---

# 24. Alert Formatter

Continue using existing Design B notifier.

DOWN:

```text
🔴 CUSTOMER DOWN

#11 HENGJAYA MINERALINDO
📍 Morowali
🌐 123.231.218.198
🔗 MAIN LINK

━━━━━━━━━━━━━━━━━━

📡 PRTG

Sensor
⭐ Ping

Status
🔴 DOWN

Last Value
No response

━━━━━━━━━━━━━━━━━━

🕒 Detected
09 Sep 2026 • 16:00 WITA
```

---

# 25. Recovery Formatter

```text
🟢 CUSTOMER RECOVERED

#11 HENGJAYA MINERALINDO
🌐 123.231.218.198

━━━━━━━━━━━━━━━━━━

📡 PRTG

Status
🟢 UP

Last Value
45 ms

━━━━━━━━━━━━━━━━━━

🕒 Recovered
09 Sep 2026 • 16:04 WITA
```

---

# 26. Direct Ping Alert

Example:

```text
🔴 CUSTOMER DOWN

#22 SANATEL
🌐 123.231.137.158

━━━━━━━━━━━━━━━━━━

🌐 DIRECT ICMP PING

Status
🔴 DOWN

Packet Loss
100%

━━━━━━━━━━━━━━━━━━

🕒 Detected
09 Sep 2026 • 16:00 WITA
```

Routing logic is identical to PRTG alert routing.

---

# 27. One Recipient Failure Must Not Block Others

If Telegram send fails:

```text
Tambang
→ error
```

still attempt:

```text
Enterprise
Global admin
```

Use isolated send attempts.

---

# 28. Alert Delivery Logging

Recommended:

```text
[NOTIFIER] #11 DOWN → 3 recipient(s)
[NOTIFIER] Sent → Tambang
[NOTIFIER] Sent → Enterprise
[NOTIFIER] Sent → admin
```

On error:

```text
[NOTIFIER] Failed → Tambang
```

Do not log Telegram token.

---

# 29. Recipient Type

Support:

```text
private chat IDs
group IDs
supergroup IDs
```

using existing Telegram send function.

---

# 30. Telegram Send Helper

Recommended centralized function:

```text
sendAlertToRecipients(message, recipients)
```

or equivalent.

Responsibilities:

```text
deduplicate
send individually
isolate failures
log summary
```

Do not duplicate loop code in DOWN and RECOVERY handlers.

---

# 31. Preserve State-First Safety

Current behavior:

```text
monitoring state saved
before notifier
```

must remain.

Do not roll back state because one Telegram group delivery fails.

---

# 32. No Duplicate Incident Notifications

Existing transition logic must remain:

```text
first confirmed DOWN
→ alert

continued DOWN
→ no duplicate

recovery
→ recovery alert
```

Adding more recipients does NOT change transition behavior.

---

# 33. Assignment Change While DOWN

If customer is currently DOWN and admin assigns it to a new Telegram group:

do NOT automatically resend historical DOWN alert unless existing architecture already supports this intentionally.

New routing applies to future alert events.

Keep behavior simple.

---

# 34. Alert Toggle While DOWN

If:

```text
receive_alerts OFF → ON
```

while customer is already DOWN:

do not generate immediate historical DOWN notification.

Future transition events follow current configuration.

---

# 35. Test Alert

Extend `/test_alert` only if safe.

Recommended:

Private admin:

```text
/test_alert
→ current existing test
```

Optional group-specific test:

```text
/test_group_alert <client_id>
```

Do NOT implement unless needed.

Prefer testing notifier routing with a controlled test customer.

---

# 36. Controlled Alert Test

Do NOT break a real customer connection.

Use:

```text
temporary test customer
simulation
test database
```

or a safe controlled monitoring target.

---

# 37. Group A/B Test

Create:

```text
Group A
Group B
```

Test customer:

```text
#24 TEST CUSTOMER
```

Assignments:

```text
Group A
can_view=1
receive_alerts=1

Group B
can_view=1
receive_alerts=0
```

Simulated DOWN:

```text
Group A
→ receives alert

Group B
→ no alert
```

---

# 38. Shared Customer Test

Set:

```text
Group A alerts ON
Group B alerts ON
```

Simulate DOWN.

Expected:

```text
A receives exactly 1
B receives exactly 1
```

---

# 39. Global Recipient Test

Verify existing admin/global target still receives the notification.

Do not regress current production alert flow.

---

# 40. Non-Alert Classification Test

Explicitly verify no alert for:

```text
#4 paused_prtg
#8 unresolved_prtg
#17 paused_prtg
#18 pic_managed
#19 pic_managed
```

regardless of Telegram group assignments.

---

# 41. Disabled Test

Temporary disabled customer with group assignment:

```text
DOWN alert
→ NEVER
```

---

# 42. Alert Recipient Repository Test

Add contract/unit-like test for:

```text
getAlertRecipientsForCustomer()
```

Scenarios:

```text
no assignment
one alerts-on group
one alerts-off group
two alerts-on groups
disabled group
duplicate-safe recipient result
```

---

# 43. Contract Tests

Extend:

```text
scripts/group-contract-test.js
```

Verify new repository/helper exports.

If notifier helper is exported and suitable:

add contract coverage.

---

# 44. Syntax

Run:

```bash
find src scripts -name '*.js' -print0 | xargs -0 -n1 node -c
```

---

# 45. Docker

Run:

```bash
docker compose build --no-cache
docker compose up -d
docker compose ps
```

---

# 46. Monitoring Regression

Logs must still show:

```text
PRTG targets: 16
Direct ping targets: 2
```

Current group count/assignment count must not alter this.

---

# 47. Database Regression

Production:

```text
customers = 23
```

must remain intact.

No PRTG/sensor mapping changes.

---

# 48. Alert Routing Documentation

Update:

```text
README.md
OPERATOR_GUIDE.md
SOP_OPERATOR.md
TROUBLESHOOTING.md
```

Document:

```text
can_view
receive_alerts
```

clearly.

---

# 49. Operator Workflow — Initial Setup

Official workflow:

```text
1. Tambahkan bot ke Telegram group.

2. Di group tersebut jalankan:
/register_group

3. Verifikasi:
/group_id

4. Assign customer:
/assign_group 11

5. Konfirmasi:
/confirm_group_assign

6. Ulangi untuk customer lain.

7. Verifikasi:
/group_clients

8. Cek monitoring:
/status

9. Cek daftar customer:
/clients
```

---

# 50. Operator Workflow — Enable Alerts

Assignment defaults should normally be:

```text
receive_alerts = 1
```

Therefore after:

```text
/assign_group 11
/confirm_group_assign
```

customer should already receive alerts in that group.

Verify using:

```text
/group_clients
```

Output should indicate:

```text
🔔 Alerts ON
```

---

# 51. Operator Workflow — Disable One Customer Alert

Inside target group:

```text
/group_alerts 11 off
```

Expected:

```text
#11 remains visible
```

but:

```text
no DOWN/RECOVERY sent to this group
```

---

# 52. Re-enable Alert

```text
/group_alerts 11 on
```

Future DOWN/RECOVERY events are sent again.

---

# 53. Operator Workflow — View Customers

Inside group:

```text
/status
```

Use for:

```text
current monitoring condition
```

Use:

```text
/clients
```

for compact customer list.

Use:

```text
/group_clients
```

for assignment/alert-routing information.

---

# 54. Operator Workflow — Remove Customer From Group

```text
/unassign_group 11
```

then:

```text
/confirm_group_unassign
```

Effect:

```text
removed from group /status
removed from group /clients
removed from /group_clients
group alerts stop
global monitoring continues
```

---

# 55. Operator Workflow — Remove Telegram Group

Inside group:

```text
/unregister_group
```

then:

```text
/confirm_group_remove
```

Effect:

```text
group access removed
group assignments removed
group alerts stop
global customer monitoring continues
```

---

# 56. Operator Workflow — Cancel

For pending actions:

```text
/cancel
```

Use for:

```text
assignment
unassignment
group removal
```

---

# 57. Operator Daily Commands

Recommended daily usage:

```text
/health
/status
```

If group operator wants the list:

```text
/clients
```

If admin wants assignment details:

```text
/group_clients
```

---

# 58. Operator Response to DOWN

When group receives:

```text
🔴 CUSTOMER DOWN
```

operator workflow:

```text
1. Identify customer.

2. Check:
/status

3. Identify backend:
PRTG or Direct Ping.

4. Verify issue in PRTG or network tools.

5. Follow office escalation procedure.

6. Wait for:
🟢 CUSTOMER RECOVERED
```

---

# 59. Important Status Meanings

Operator must understand:

```text
🔴 DOWN
→ active monitoring confirmed failure

🟢 UP
→ active monitoring healthy

⏸ PAUSED
→ PRTG paused, NOT DOWN

🧩 UNRESOLVED
→ mapping incomplete, NOT DOWN

👤 PIC MANAGED
→ handled outside bot

🚫 DISABLED
→ bot ignores customer
```

---

# 60. Group Visibility vs Alerts

Document clearly:

```text
can_view=1
receive_alerts=1
→ visible + alert

can_view=1
receive_alerts=0
→ visible + no alert
```

Do not confuse these.

---

# 61. Group Alert Troubleshooting

If expected alert does not arrive:

check:

```text
1. Customer assigned?
/group_clients

2. Alerts ON?

3. Group enabled?

4. Customer alert eligible?
active_prtg / active_icmp

5. Monitoring transition actually occurred?

6. Check Docker logs.
```

---

# 62. Alert Routing Log Troubleshooting

Useful:

```bash
docker compose logs --tail=150 prtg-bot
```

Look for:

```text
[NOTIFIER]
Telegram error
recipient
```

Do not expose secrets.

---

# 63. No Alert for Paused

If operator asks why paused customer does not send DOWN:

Answer:

```text
PAUSED is not an outage state.
The bot intentionally suppresses DOWN alerts.
```

---

# 64. No Alert for Unresolved

Explain:

```text
customer has no valid active monitoring mapping
therefore bot cannot confirm DOWN
```

Do not alert until mapping is resolved.

---

# 65. No Alert for PIC Managed

Explain:

```text
monitoring responsibility belongs to external PIC
```

Telegram assignment is visibility only.

---

# 66. V8.6 Definition of Done

V8.6 is complete when:

```text
✅ assigned customer can route alert to Telegram group

✅ receive_alerts=1 sends alerts

✅ receive_alerts=0 suppresses group alerts

✅ can_view remains independent

✅ active_prtg alert routing works

✅ active_icmp alert routing works

✅ DOWN routes correctly

✅ RECOVERY routes correctly

✅ one customer can alert multiple groups

✅ one group receives no duplicate alert

✅ disabled group receives no alert

✅ unregistered group receives no alert

✅ global/admin alert behavior preserved

✅ one recipient failure does not block others

✅ paused customer never alerts

✅ unresolved customer never alerts

✅ PIC-managed customer never alerts

✅ disabled customer never alerts

✅ group assignment does not affect monitoring targets

✅ global monitoring remains 18 active

✅ production customers remain 23

✅ Design B notifications preserved

✅ syntax tests pass

✅ contract tests pass

✅ Docker build passes

✅ runtime routing tests pass

✅ documentation updated

✅ operator workflow documented
```

---

# 67. Recommended Implementation Order

Implement:

```text
1. Audit current notifier recipient logic.

2. Add/finalize getAlertRecipientsForCustomer().

3. Preserve existing global recipients.

4. Build merged recipient list.

5. Deduplicate chat IDs.

6. Add isolated recipient send loop.

7. Route DOWN.

8. Route RECOVERY.

9. Add /group_alerts <id> on|off.

10. Update /group_clients display.

11. Add contract tests.

12. Run controlled DOWN test.

13. Run controlled RECOVERY test.

14. Verify alerts-off behavior.

15. Verify multi-group behavior.

16. Verify non-active classifications never alert.

17. Verify monitoring baseline unchanged.

18. Update operator documentation.
```

---

# 68. Final Expected Architecture

```text
                PRTG / ICMP
                    │
                    ▼
             GLOBAL MONITOR
                    │
                    ▼
              STATE CHANGE
                    │
                    ▼
                 NOTIFIER
                    │
         ┌──────────┴──────────┐
         │                     │
         ▼                     ▼
 Global/Admin              Group Router
 Recipient(s)                  │
                         customer assignment
                               │
                     receive_alerts = 1
                               │
                     ┌─────────┴─────────┐
                     ▼                   ▼
                  Tambang            Other Group
```

Telegram group routing is a notification layer.

Monitoring remains global.
