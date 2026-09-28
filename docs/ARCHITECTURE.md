# Architecture Documentation

## Overview

This document describes the architecture of the PRTG Telegram Bot, a modular monolith built with Node.js, TypeScript, and Telegraf.

## Modular Monolith Approach

The application follows a **modular monolith** architecture where:

- **Single deployable unit** - One process, one database
- **Clear module boundaries** - Each module owns its domain logic and data
- **Explicit dependencies** - Modules communicate through well-defined interfaces
- **No circular dependencies** - Dependency flow is strictly controlled

## Module Boundaries

```
src/
├── app.ts                 # Entry point, wiring
├── bootstrap.ts           # Dependency construction
├── config/                # Configuration (single source of truth)
├── core/                  # Cross-cutting concerns
│   ├── errors/            # AppError, error handling
│   ├── logger.ts          # Pino structured logging
│   └── types/             # Shared TypeScript types
├── modules/               # Business logic (domain modules)
│   ├── customers/         # Customer registry
│   ├── groups/            # Telegram groups & access
│   ├── imports/           # CSV import parsing
│   └── mapping/           # PRTG mapping logic
├── integrations/          # External system adapters
│   ├── telegram/          # Telegraf bot, commands, UI
│   ├── prtg/              # PRTG API client
│   └── icmp/              # ICMP ping client
├── infrastructure/        # Technical infrastructure
│   └── database/          # SQLite, migrations, repositories
└── shared/                # Pure utilities (no dependencies)
```

## Dependency Flow

```
                    ┌─────────────┐
                    │   config    │
                    └──────┬──────┘
                           │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   ┌─────────┐      ┌───────────┐     ┌──────────┐
   │  core   │      │ modules   │     │integrations│
   └────┬────┘      └─────┬─────┘     └────┬─────┘
        │                 │                │
        │          ┌──────┴──────┐         │
        │          ▼             ▼         ▼
        │    ┌─────────┐   ┌──────────┐ ┌───────┐
        │    │services │◄──│repositories│ │telegram│
        │    └────┬────┘   └────┬─────┘ └───┬────┘
        │         │             │           │
        │    ┌────┴────┐        │           │
        │    │database │◄───────┘           │
        │    └─────────┘                    │
        └───────────────────────────────────┘
```

**Rules:**
- `config` → everything (read-only)
- `core` → modules, integrations, infrastructure
- `modules` → core, infrastructure/database
- `integrations` → core, modules (via services)
- `infrastructure` → core
- `shared` → no internal dependencies

## Repository/Service/Adapter Responsibilities

### Repositories (Data Access)
- **Only** database operations
- No business logic
- Parameterized queries only
- One repository per aggregate/table group

Examples:
- `CustomerRepository` - customers table
- `GroupRepository` - telegram_groups, group_customer_access
- `MappingRepository` - prtg_mappings

### Services (Business Logic)
- Orchestrate repositories
- Enforce business rules
- Validate inputs
- Coordinate cross-repository operations
- No direct database access
- No Telegram/PRTG coupling

Examples:
- `CustomerService` - customer lifecycle, validation
- `GroupService` - group registration, access assignment
- `AccessService` - authorization decisions
- `MappingService` - mapping decisions, matcher coordination
- `CsvImportService` - import workflow, parser coordination

### Adapters (External Systems)
- Translate external APIs to domain types
- Handle retries, timeouts, errors
- No business logic

Examples:
- `PrtgClient` - PRTG API → domain types
- `PingClient` - ICMP → domain types
- Telegram bot/handlers - Telegram updates → service calls

## Telegram Adapter Isolation

Telegram handlers are **adapters only**:

```
Telegram Update
       │
       ▼
┌──────────────────┐
│  Middleware      │  (auth, error handling, context enrichment)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Command Handler │  (parse input → call service → format output)
└────────┬─────────┘
         │
         ▼
    Service Layer
```

**Handlers must NOT:**
- Run raw SQL
- Implement PRTG matching algorithms
- Perform access control inline
- Hardcode admin IDs
- Construct PRTG API URLs with credentials

## Configuration Validation

All environment variables validated **once** at startup in `src/config/env.ts` using Zod.

- Typed config object consumed by modules
- No `process.env` outside `src/config/env.ts` (single source of truth)
- Secrets never logged

## Database Design

### Migration-Based
- Explicit migration runner (`migration-runner.ts`)
- Versioned SQL files in `migrations/`
- Tracking table: `schema_migrations`
- Safe to run multiple times

### Tables

| Table | Purpose |
|-------|---------|
| `customers` | Customer registry with monitor type |
| `telegram_groups` | Registered groups |
| `group_customer_access` | Visibility + alert routing (separate!) |
| `prtg_mappings` | PRTG object mappings (separate from customers) |

### Key Design Decisions

1. **Visibility ≠ Alerts** - `can_view` and `receive_alerts` are separate columns
2. **PRTG mappings separate** - Not embedded in customers table
3. **Telegram IDs as TEXT** - Handles large negative group IDs
4. **Foreign keys enforced** - `PRAGMA foreign_keys = ON`

## Global Group Concept

- Configured via `TELEGRAM_GLOBAL_GROUP_ID`
- Recognized by exact string chat ID comparison against `config.GLOBAL_GROUP_ID`
- **Does not imply admin** - separate authorization
- Visibility is config-based: `isGlobalGroup()` returns `true` without any DB row
- `getCustomerAccessScope()` returns `{ kind: 'all' }` for Global Group (all enabled customers visible)
- `canReceiveAlerts()` requires explicit subscription row in `group_customer_access`
- Lightweight `telegram_groups` row may be created by `assignCustomer`/`setAlertSubscription` for FK integrity only; its absence does not affect Global Group identity

### Global Group Access Control

Global Group identity is config-based (exact chat ID match via `TELEGRAM_GLOBAL_GROUP_ID`).
- **Read scope**: all enabled customers (`getCustomerAccessScope` returns `{ kind: 'all' }`)
- **Mutation scope**: Global non-admin members cannot manage customers; only configured bot admins can mutate customer registry, enable/disable clients, or upload/import CSV.

Authorization uses central `canManageCustomers()` which requires admin status:

```typescript
// access.service.ts
canManageCustomers(context): boolean {
  if (isAdmin(context.userId)) {
    if (isPrivateChat(context.chatType)) return true;
    if (isGlobalGroup(context.chatId)) return true;
  }
  return false;
  // Global non-admin: false (read-only)
}
```

### Unregister Protection

The Global Group cannot be unregistered via `/unregister_group`. The command and callback handler both check `isGlobalGroup()` and reject the operation.

## Visibility vs Alert Routing

```
group_customer_access
├── can_view = 1        → Can see customer in /clients, /status
└── receive_alerts = 1  → Receives DOWN/RECOVERY notifications
```

These are independent. A group can:
- View but not receive alerts
- Receive alerts (implies view in practice)
- Neither

## assignCustomer Semantics

`assignCustomer` uses `ON CONFLICT` with conditional update for `receive_alerts`:

- On first assignment (INSERT): `can_view` and `receive_alerts` are set from input
- On re-assignment (UPDATE): `can_view` is always updated; `receive_alerts` is only set to `1` if the input value is truthy, otherwise the existing value is preserved

This means `setAlertSubscription()` is the canonical way to toggle alerts off; `assignCustomer()` with `receiveAlerts: false` will not clear an existing alert subscription.

## updateAccess Cleanup

`updateAccess()` removes the `group_customer_access` row when both `can_view` and `receive_alerts` become `false` (zero/zero cleanup).

## CSV Import Flow

```
CSV File
    │
    ▼
┌──────────────────┐
│  CsvImportParser │  (csv-parse library, strict validation)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ CsvImportService │  (preview → confirm → transactional import)
└────────┬─────────┘
         │
         ▼
   CustomerService.bulkCreate()
         │
         ▼
   CustomerRepository (transaction)
```

Validation rules:
- Required headers: `client_id`, `name`, `monitor_type`
- Optional: `ping_host`
- UTF-8, trimmed, duplicate detection
- Row-numbered errors

## Automatic/Manual PRTG Mapping Design

### Matcher Pipeline

```
Customer (client_id, name)
       │
       ▼
┌──────────────────┐
│ MappingMatcher   │  (pure function, testable with fixtures)
│  - normalize     │
│  - token overlap │
│  - exact match   │
│  - sensor pref   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Decision        │
│  automatic       │  (confidence ≥ 0.9, single candidate or clear gap)
│  suggestions     │  (confidence ≥ 0.5, multiple candidates)
│  unresolved      │  (no candidates meet threshold)
└──────────────────┘
```

### Operator-Assisted UX (Future)

```
⚠️ CLIENT NOT MAPPED
Client ID : 8
Name      : ANUGRAH
Status    : UNMAPPED

Suggested PRTG objects:
• 4036 — Device ... — Ping
• 3876 — Device ... — Ping

[ Map #4036 ] [ Map #3876 ] [ Search Other Object ]
```

Callback data: `map:<customerId>:<prtgObjectId>` (compact, stable)

### Safety Rules

- Never auto-map on vague similarity
- Ambiguous → suggestions, not auto
- Manual mapping: verify admin, verify customer exists, verify PRTG object
- Store `mapping_method = manual`, `verified = 1`, `mapped_by_telegram_id`

## Monitoring Engine (V6)

The monitoring engine runs as a background scheduler — it does NOT import Telegraf handlers or UI components. It polls PRTG and ICMP sources, computes state changes via a pure reducer, and persists transitions to SQLite.

```
┌────────────────────────────────────────────────────────────────┐
│                    MonitoringEngine                             │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────────┐  │
│  │  PRTG Cycle │  │  ICMP Cycle │  │                       │  │
│  │  - Poll V4  │  │  - Probe    │  │  monitoring.reducer   │  │
│  │    cache    │  │    hosts    │  │  - Pure state machine │  │
│  │  - Refresh  │  │  - Validate │  │  - Stabilization (N=2)│  │
│  │    on gen   │  │    hosts    │  │  - Fingerprint reset  │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────────────────┘  │
│         │               │                                     │
│         ▼               ▼                                     │
│  ┌───────────────────────────────────────────────────────┐    │
│  │  observation[] → reduceState() → MonitoringState       │    │
│  │    - UP / DOWN / UNKNOWN                               │    │
│  │    - consecutiveCount / stableHealth                   │    │
│  │    - lastTransitionKind                                │    │
│  └────────────────────────┬──────────────────────────────┘    │
│                           │                                   │
│                           ▼                                   │
│  ┌───────────────────────────────────────────────────────┐    │
│  │  MonitoringRepository (better-sqlite3)                 │    │
│  │    - upsertBatch()                                     │    │
│  │    - findById() / findAll()                            │    │
│  │    - Schema: monitoring_states table                   │    │
│  └───────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
```

### Key Decisions
- **Env injection only**: Config flows from `getConfig()` → `createMonitoringConfig()` → `createMonitoringEngine()`
- **Injectable clock**: `clock: () => number` for deterministic testing
- **Injectable setTimeout**: Returns objects with `.cancel()` for test cleanup
- **ICMP host validation**: `validateHost()` rejects option injection, whitespace, control chars, URL-like input, shell metacharacters — before any `spawn()`
- **No Telegraf import**: Engine is pure domain code
- **Graceful shutdown**: `engine.stop()` cancels timers on SIGINT/SIGTERM

## CSV Import (V2)

### Import Flow with Confirmation

```
CSV File Upload
      │
      ▼
┌──────────────────┐
│  File Validation │  (extension, size, MIME)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  CsvImportParser │  (strict validation, duplicate detection)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ CsvImportService │  (dry-run preview, classify new/dup/existing)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Preview Card    │  (shows first 5 rows, counts, errors)
│  [Confirm][Cancel]│
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
Confirm   Cancel
    │         │
    ▼         ▼
┌──────────────────┐
│ CsvImportService │  (transactional bulkCreate)
│   .import()      │
└────────┬─────────┘
         │
         ▼
   Result Message
```

### CSV Format

```csv
client_id,name,monitor_type,ping_host
101,Customer One,prtg,
102,Customer Two,icmp,10.10.10.10
```

- **Required headers**: `client_id`, `name`, `monitor_type`
- **Optional header**: `ping_host` (required for `icmp` monitor type)
- **Monitor types**: `prtg`, `icmp`, `pic`, `disabled`
- **File size limit**: 1 MiB
- **Import flow**: Upload → Preview (dry-run) → Confirm → Transactional import

## Automatic/Manual PRTG Mapping Design

### Matcher Pipeline

```
Customer (client_id, name)
       │
       ▼
┌──────────────────┐
│ MappingMatcher   │  (pure function, testable with fixtures)
│  - normalize     │
│  - token overlap │
│  - exact match   │
│  - sensor pref   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Decision        │
│  automatic       │  (confidence ≥ 0.9, single candidate or clear gap)
│  suggestions     │  (confidence ≥ 0.5, multiple candidates)
│  unresolved      │  (no candidates meet threshold)
└──────────────────┘
```

### Operator-Assisted UX (Future)

```
⚠️ CLIENT NOT MAPPED
Client ID : 8
Name      : ANUGRAH
Status    : UNMAPPED

Suggested PRTG objects:
• 4036 — Device ... — Ping
• 3876 — Device ... — Ping

[ Map #4036 ] [ Map #3876 ] [ Search Other Object ]
```

Callback data: `map:<customerId>:<prtgObjectId>` (compact, stable)

### Safety Rules

- Never auto-map on vague similarity
- Ambiguous → suggestions, not auto
- Manual mapping: verify admin, verify customer exists, verify PRTG object
- Store `mapping_method = manual`, `verified = 1`, `mapped_by_telegram_id`

## Monitoring Engine (V6)

The monitoring engine runs as a background scheduler — it does NOT import Telegraf handlers or UI components. It polls PRTG and ICMP sources, computes state changes via a pure reducer, and persists transitions to SQLite.

```
┌────────────────────────────────────────────────────────────────┐
│                    MonitoringEngine                             │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────────┐  │
│  │  PRTG Cycle │  │  ICMP Cycle │  │                       │  │
│  │  - Poll V4  │  │  - Probe    │  │  monitoring.reducer   │  │
│  │    cache    │  │    hosts    │  │  - Pure state machine │  │
│  │  - Refresh  │  │  - Validate │  │  - Stabilization (N=2)│  │
│  │    on gen   │  │    hosts    │  │  - Fingerprint reset  │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────────────────┘  │
│         │               │                                     │
│         ▼               ▼                                     │
│  ┌───────────────────────────────────────────────────────┐    │
│  │  observation[] → reduceState() → MonitoringState       │    │
│  │    - UP / DOWN / UNKNOWN                               │    │
│  │    - consecutiveCount / stableHealth                   │    │
│  │    - lastTransitionKind                                │    │
│  └────────────────────────┬──────────────────────────────┘    │
│                           │                                   │
│                           ▼                                   │
│  ┌───────────────────────────────────────────────────────┐    │
│  │  MonitoringRepository (better-sqlite3)                 │    │
│  │    - upsertBatch()                                     │    │
│  │    - findById() / findAll()                            │    │
│  │    - Schema: monitoring_states table                   │    │
│  └───────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
```

### Key Decisions
- **Env injection only**: Config flows from `getConfig()` → `createMonitoringConfig()` → `createMonitoringEngine()`
- **Injectable clock**: `clock: () => number` for deterministic testing
- **Injectable setTimeout**: Returns objects with `.cancel()` for test cleanup
- **ICMP host validation**: `validateHost()` rejects option injection, whitespace, control chars, URL-like input, shell metacharacters — before any `spawn()`
- **No Telegraf import**: Engine is pure domain code
- **Graceful shutdown**: `engine.stop()` cancels timers on SIGINT/SIGTERM

## Text Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      TELEGRAM BOT                           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────┐   │
│  │ /help   │  │ /chatid │  │ /import │  │ /map_client │   │
│  └────┬────┘  └────┬────┘  └────┬────┘  └──────┬──────┘   │
└───────┼────────────┼────────────┼────────────┼────────────┘
        │            │            │            │
        ▼            ▼            ▼            ▼
┌─────────────────────────────────────────────────────────────┐
│                     SERVICE LAYER                           │
│  ┌────────────┐ ┌──────────┐ ┌────────────┐ ┌───────────┐  │
│  │ CustomerSvc│ │ GroupSvc │ │ImportSvc   │ │ MappingSvc│  │
│  └─────┬──────┘ └────┬─────┘ └─────┬──────┘ └─────┬─────┘  │
└────────┼─────────────┼─────────────┼─────────────┼──────────┘
         │             │             │             │
         ▼             ▼             ▼             ▼
┌─────────────────────────────────────────────────────────────┐
│                    REPOSITORY LAYER                         │
│  ┌────────────┐ ┌──────────┐ ┌────────────┐ ┌───────────┐  │
│  │CustomerRepo│ │ GroupRepo│ │            │ │MappingRepo│  │
│  └─────┬──────┘ └────┬─────┘ │            │ └─────┬─────┘  │
└────────┼─────────────┼───────────────────────┼──────────┘
         │             │                       │
         ▼             ▼                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      SQLITE DATABASE                        │
│  customers ◄──► telegram_groups ◄──► group_customer_access  │
│                                    ▲                        │
│                                    │                        │
│                              prtg_mappings                  │
└─────────────────────────────────────────────────────────────┘
         │                       │
         ▼                       ▼
┌──────────────┐          ┌──────────────┐
│  PRTG API    │          │   ICMP       │
│  (future)    │          │   (future)   │
└──────────────┘          └──────────────┘
```

## Summary

This architecture ensures:
- **Testability** - Domain logic independent of Telegram, DB, PRTG
- **Maintainability** - Clear boundaries, single responsibility
- **Extensibility** - New modules integrate without touching core
- **Safety** - Validation at boundaries, no secrets in logs