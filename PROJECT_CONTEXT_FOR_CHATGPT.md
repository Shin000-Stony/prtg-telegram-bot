# PRTG Telegram Bot - Project Context for ChatGPT

## Project Overview
A professional Telegram bot for monitoring customers using PRTG and direct ICMP monitoring. Supports multi-customer environments with group-based access control.

**Tech Stack**: TypeScript, Node.js 22+, Telegraf 4.16, SQLite (better-sqlite3), Zod, Pino, Vitest
**Architecture**: Modular Monolith with clear module boundaries
**Test Suite**: 997 tests (994 passing, 3 pre-existing failures unrelated to V8)

---

## Key Configuration

### Environment Variables (validated in `src/config/env.ts`)
```env
NODE_ENV=production
LOG_LEVEL=info
TZ=Asia/Makassar

TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_ADMIN_IDS=123456789,987654321
TELEGRAM_GLOBAL_GROUP_ID=-1001234567890

DATABASE_PATH=/data/prtg_bot.db

PRTG_BASE_URL=https://prtg.example.com/api
PRTG_USERNAME=apiuser
PRTG_PASSHASH=your_passhash
PRTG_TLS_REJECT_UNAUTHORIZED=false

MONITORING_ENABLED=false
PRTG_POLL_INTERVAL_MS=60000
ICMP_POLL_INTERVAL_MS=30000
ICMP_TIMEOUT_MS=3000
ICMP_CONCURRENCY=5
ALERTS_ENABLED=false
ALERT_DISPATCH_INTERVAL_MS=1000
ALERT_MAX_EVENT_AGE_MS=900000
ALERT_MAX_ATTEMPTS=5
```

### Monitor Types
- `prtg` - PRTG sensor monitoring (requires PRTG mapping)
- `icmp` - Direct ICMP ping monitoring (requires ping_host)
- `pic` - PIC managed (read-only)
- `disabled` - Disabled

---

## Project Structure
```
src/
├── app.ts                      # Entry point, wires all commands and handlers
├── bootstrap.ts                # Dependency initialization
├── config/
│   ├── env.ts                  # Zod-validated config (single source of truth)
│   └── constants.ts            # Monitor types, chat types, mapping methods
├── core/
│   ├── errors/app-error.ts     # AppError class with error codes
│   ├── logger.ts               # Pino structured logging
│   └── types/index.ts          # Shared TypeScript types
├── modules/
│   ├── customers/              # Customer registry
│   │   ├── customer.repository.ts
│   │   ├── customer.service.ts
│   │   ├── customer.types.ts
│   │   ├── customer.validators.ts
│   │   └── pending-delete.store.ts
│   ├── groups/                 # Telegram groups & access control
│   │   ├── group.repository.ts
│   │   ├── group.service.ts
│   │   ├── access.service.ts
│   │   ├── group.types.ts
│   │   ├── group-alerts.store.ts
│   │   ├── clients-pagination.store.ts
│   │   └── pending-unregister.store.ts
│   ├── imports/                # CSV bulk import
│   │   ├── csv-import.service.ts
│   │   ├── csv-import.parser.ts
│   │   ├── csv-import.types.ts
│   │   └── pending-import.store.ts
│   ├── mapping/                # PRTG object mapping
│   │   ├── mapping.service.ts
│   │   ├── mapping.matcher.ts
│   │   ├── mapping.repository.ts
│   │   ├── mapping.types.ts
│   │   └── pending-mapping.store.ts
│   ├── alerts/                 # Alert dispatching (V7)
│   │   ├── alert.dispatcher.ts
│   │   ├── alert.policy.ts
│   │   ├── alert.repository.ts
│   │   ├── alert.types.ts
│   │   └── alerting-monitoring.repository.ts
│   └── monitoring/             # Monitoring engine (V6)
│       ├── monitoring.engine.ts
│       ├── monitoring.factory.ts
│       ├── monitoring.repository.ts
│       ├── monitoring.reducer.ts
│       ├── monitoring.types.ts
│       └── icmp.adapter.ts
├── integrations/
│   ├── telegram/
│   │   ├── bot.ts              # Telegraf bot with auth/error middleware
│   │   ├── context.ts          # Extended context types
│   │   ├── telegram-alert.sender.ts
│   │   ├── commands/           # All command handlers
│   │   ├── handlers/           # Callback handlers
│   │   └── ui/                 # Message formatting, cards
│   ├── prtg/
│   │   ├── prtg.client.ts
│   │   ├── prtg.transport.ts
│   │   ├── prtg.inventory.cache.ts
│   │   ├── prtg.types.ts
│   │   └── prtg-inventory.shared.ts
│   └── icmp/
│       └── ping.client.ts
├── infrastructure/
│   └── database/
│       ├── database.ts
│       └── migration-runner.ts
└── shared/
    ├── strings.ts
    └── time.ts
```

---

## Core Files for Understanding the V6 Monitoring Issue

### 1. Monitoring Engine (`src/modules/monitoring/monitoring.engine.ts`)
**Key insight**: PRTG and ICMP cycles are COMPLETELY SEPARATE - they filter customers by `monitorType`:
```typescript
// PRTG cycle - ONLY polls monitorType: 'prtg'
const customers = this.deps.customerService.listAll({ enabled: true, monitorType: 'prtg' });

// ICMP cycle - ONLY polls monitorType: 'icmp'
const customers = this.deps.customerService.listAll({ enabled: true, monitorType: 'icmp' });
```

### 2. ICMP Adapter (`src/modules/monitoring/icmp.adapter.ts`)
Returns `UNKNOWN` for:
- Host validation failures (invalid hostname, whitespace, control chars, option injection)
- Timeout (`exit_code_143` or null)
- Process errors (ENOENT, EACCES, ABORT_ERR)
- Non-zero exit codes other than 0 (UP) or 1 (DOWN)

### 3. Monitoring Reducer (`src/modules/monitoring/monitoring.reducer.ts`)
Pure state machine with stabilization threshold of 2:
- UNKNOWN observations: reset consecutiveCount, don't affect stableHealth
- WARNING/UNUSUAL/PAUSED: reset consecutiveCount
- UP/DOWN: increment consecutiveCount, stabilize after 2 consecutive same readings
- Fingerprint mismatch → full state reset

### 4. Fingerprint System (`src/modules/monitoring/monitoring.reducer.ts:25-27`)
```typescript
export function fingerprintToString(monitorType: string, enabled: boolean, pingHost: string | null, prtgObjectId: number | null): string {
  return `${monitorType}|${enabled}|${pingHost ?? ''}|${prtgObjectId ?? ''}`;
}
```
**Critical**: Fingerprint includes `monitorType`, so PRTG and ICMP states are completely isolated.

### 5. Alert Policy (`src/modules/alerts/alert.policy.ts`)
Creates alerts on stable transitions (UP↔DOWN):
- Uses correct poll interval per monitor type (line 121)
- Validates fingerprint matches current config (lines 88-96)
- Rejects stale observations (lines 134-137)

### 6. Customer Validators (`src/modules/customers/customer.validators.ts`)
Enforces: ICMP requires `pingHost`, but PRTG can also have `pingHost` (not validated against)

---

## The Issue You're Describing

> "ICMP polling gives an unknown output when the client is down in the PRTG"

### Architecture Fact
**A customer can only have ONE monitor type**. The system does NOT support dual monitoring (PRTG + ICMP) for a single customer record.

### What This Means
1. If customer has `monitorType: 'prtg'` → ONLY PRTG cycle polls it, ICMP cycle ignores it
2. If customer has `monitorType: 'icmp'` → ONLY ICMP cycle polls it, PRTG cycle ignores it
3. If you want both: create TWO separate customer records

### Possible Scenarios
| Scenario | Expected Behavior |
|----------|-------------------|
| Single customer, `monitorType: 'prtg'`, also has `pingHost` | ICMP will NEVER poll it. PRTG shows DOWN, ICMP shows nothing. |
| Two customers for same host: A=`prtg`, B=`icmp` | Independent. A shows PRTG DOWN. B shows ICMP result (could be UNKNOWN if ping fails). |
| Customer changed from `prtg` to `icmp` | Fingerprint changes → state resets → starts fresh ICMP monitoring. |

---

## Files to Share with ChatGPT (Priority Order)

### Essential for Understanding the Issue:
1. `src/modules/monitoring/monitoring.engine.ts` - Core monitoring logic
2. `src/modules/monitoring/icmp.adapter.ts` - ICMP probing implementation
3. `src/modules/monitoring/monitoring.reducer.ts` - State machine
4. `src/modules/monitoring/monitoring.factory.ts` - Engine wiring
5. `src/modules/customers/customer.types.ts` - Customer data model
6. `src/modules/customers/customer.validators.ts` - Validation rules
7. `src/modules/alerts/alert.policy.ts` - Alert creation logic
8. `src/config/constants.ts` - Monitor type definitions

### Supporting Context:
9. `docs/ARCHITECTURE.md` - Full architecture documentation
10. `README.md` - Project overview and commands
11. `src/app.ts` - Application entry point
12. `src/bootstrap.ts` - Dependency graph

---

## How to Reproduce/Debug

1. **Check customer's monitorType**:
   ```bash
   # Via bot command
   /client <client_id>
   ```

2. **Check monitoring state in DB**:
   ```sql
   SELECT * FROM monitoring_states WHERE customer_id = ?;
   ```

3. **Check logs for ICMP cycle**:
   Look for "Monitoring cycle completed" logs with `cycle: 'icmp'`

4. **Verify ICMP host validation**:
   Check `validateHost()` in `icmp.adapter.ts:37-79` - rejects many formats

---

## Test Files for Reference
- `tests/unit/modules/monitoring/monitoring.reducer.test.ts` - State machine tests
- `tests/unit/modules/monitoring/icmp.adapter.test.ts` - ICMP adapter tests
- `tests/unit/modules/monitoring/monitoring.engine.test.ts` - Engine integration tests
- `tests/integration/alerts/alerting-monitoring.rollback.test.ts` - Alert integration

---

## Commands to Run
```bash
npm run dev          # Development with hot reload
npm run test         # Run all tests
npm run typecheck    # TypeScript checking
npm run lint         # ESLint
npm run db:migrate   # Run migrations
```

---

## Summary for ChatGPT

**The system is designed correctly**: PRTG and ICMP are separate monitoring paths per customer. If you're seeing ICMP UNKNOWN for a PRTG customer, it's because:
1. The customer is `monitorType: 'prtg'` → ICMP doesn't poll it at all
2. You have a separate ICMP customer for the same host that's failing ping validation

**To fix**: Either create a separate ICMP customer record, or change the existing customer to `monitorType: 'icmp'` (losing PRTG monitoring).

There is no code vulnerability - this is the intended architecture.