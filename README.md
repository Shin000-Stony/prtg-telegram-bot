# PRTG Telegram Bot

A professional Telegram bot for monitoring customers using PRTG and direct ICMP monitoring.

## Project Purpose

This bot provides a centralized monitoring interface for PRTG sensors and direct ICMP endpoints, with Telegram-based alerting and status commands. It supports multi-customer environments with group-based access control.

## Prerequisites

- Node.js 22+
- Docker & Docker Compose (for containerized deployment)
- Telegram Bot Token (from @BotFather)
- PRTG Server access (for PRTG monitoring features)
- SQLite (included, no separate installation needed)

## Installation

### Local Development

```bash
# Clone and navigate to project
cd prtg_telegram_bot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
# Required: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_IDS

# Run database migrations
npm run db:migrate

# Start development server
npm run dev
```

### Docker Deployment

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with your values

# Build and start
docker compose up -d --build

# View logs
docker compose logs -f
```

## Environment Setup

Required variables in `.env`:

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
```

### Key Configuration Notes

- `TELEGRAM_ADMIN_IDS`: Comma-separated list of Telegram user IDs (not usernames)
- `TELEGRAM_GLOBAL_GROUP_ID`: Optional group chat ID for global alerts (can be empty for development)
- `PRTG_TLS_REJECT_UNAUTHORIZED`: Set to `true` in production with valid certificates
- Never commit `.env` file to version control

## Development Commands

```bash
npm run dev        # Start development server with hot reload
npm run build      # Compile TypeScript to dist/
npm run start      # Run compiled production build
npm run test       # Run all tests
npm run test:watch # Run tests in watch mode
npm run typecheck  # TypeScript type checking
npm run lint       # ESLint code linting
npm run db:migrate # Run database migrations
```

## Docker Startup

```bash
# Production
docker compose up -d

# With build
docker compose up -d --build

# Stop
docker compose down

# View logs
docker compose logs -f bot
```

## V3 Commands

| Command | Description | Context |
|---------|-------------|---------|
| `/register_group` | Register current group for customer assignments | Private chat only |
| `/unregister_group` | Remove group registration (with confirmation) | Admin + Registered group |
| `/groups` | List registered groups | Admin only |
| `/assign_client <client_id> [alerts]` | Grant group visibility (and optionally alerts) to a customer | Admin + Private/Global Group |
| `/unassign_client <client_id>` | Revoke group access to a customer | Admin + Private/Global Group |
| `/group_clients` | List customers visible in current group | Group members |
| `/group_alerts` | Interactive menu or toggle alerts: `/group_alerts` (menu) or `/group_alerts <client_id> on|off` | Admin + Group members |

### V2 Commands

| Command | Description | Context |
|---------|-------------|---------|
| `/help` | Show help message (context-aware) | Private, Group, Supergroup |
| `/chatid` | Show current chat ID and type | Private, Group, Supergroup |
| `/clients` | List visible customers (8 per page) | Admin/Global: all; Group: assigned only |
| `/clients <keyword>` | Search by name or client ID | Admin/Global: all; Group: assigned only |
| `/clients <page>` | Jump to page number | Same as above |
| `/client <client_id>` | Show customer detail | Visible customers only |
| `/add_client <id> \| <name> \| <type> \| [ping_host]` | Create customer | Admin + Private/Global Group |
| `/enable_client <client_id>` | Enable customer | Admin + Private/Global Group |
| `/disable_client <client_id>` | Disable customer | Admin + Private/Global Group |
| `/delete_client <client_id>` | Delete customer permanently (with confirm flow) | Admin + Private/Global Group |
| CSV upload | Upload CSV to import customers | Admin + Private/Global Group |

### CSV Import Flow

The CSV import uses a safe template → upload → preview → confirm workflow:

1. Run `/csv_upload` to receive the template file (`customer_import_template.csv`)
2. Fill in customers (keep the header row) — save as CSV, max 1 MiB
3. Upload the completed `.csv` back to the bot (admin in private chat or Global Group only)
4. Review preview — dry-run shows counts, duplicates, and errors
5. Confirm with inline keyboard (`✅ Confirm Import` / `❌ Cancel`)
6. On confirm: transactional bulk insert into database

**Cancel at any time:** the `❌ Cancel` button aborts the import without writing data.

Required columns: `client_id`, `name`, `monitor_type` · Optional: `ping_host` (for `icmp`) · Allowed types: `prtg`, `icmp`, `pic`, `disabled`

### Permission Context Summary

| Context | Can View Customers | Can Manage (add/enable/disable/delete) | Can Import CSV | Can Manage Groups |
|---------|-------------------|----------------------------------------|----------------|-------------------|
| Bot Admin — Private Chat | All | Yes | Yes | No |
| Bot Admin — Global Group | All | Yes | Yes | Yes |
| Bot Admin — Ordinary Group | Assigned only | No (except group ops) | No | Yes (own group) |
| Non-Admin — Global Group | All | No | No | No |
| Non-Admin — Ordinary Group | Assigned only | No | No | No |

> `can_manage_customers` = admin + (private chat OR Global Group). This governs all mutation commands.

### Configuration Reference (Intervals & Timeouts)

| Variable | Default | Description |
|----------|---------|-------------|
| `MONITORING_ENABLED` | `false` | Enable background monitoring engine |
| `PRTG_POLL_INTERVAL_MS` | `60000` (60s) | PRTG API poll interval |
| `ICMP_POLL_INTERVAL_MS` | `30000` (30s) | ICMP ping poll interval |
| `ICMP_TIMEOUT_MS` | `3000` | Per-host ICMP timeout |
| `ICMP_CONCURRENCY` | `5` | Max parallel ICMP probes |
| `ALERTS_ENABLED` | `false` | Enable alert routing (requires `MONITORING_ENABLED=true`) |
| `ALERT_DISPATCH_INTERVAL_MS` | `1000` | Alert dispatch loop interval |
| `ALERT_MAX_EVENT_AGE_MS` | `900000` (15min) | Alert event expiry |
| `ALERT_MAX_ATTEMPTS` | `5` | Max delivery retries before failure |

> **Note:** Some timeouts are hardcoded in source, not env-configurable:
> - PRTG API request timeout: `REQUEST_TIMEOUT_MS = 20_000` (`src/integrations/prtg/prtg.transport.ts`)
> - PRTG inventory refresh deadline: `REFRESH_DEADLINE_MS = 120_000` (`src/integrations/prtg/prtg.inventory.cache.ts`)

## Architecture Overview

This is a **modular monolith** with clear boundaries:

```
src/
├── app.ts                 # Application entry point
├── bootstrap.ts           # Dependency initialization
├── config/                # Configuration layer (Zod-validated)
├── core/                  # Core utilities (errors, logger, types)
├── modules/               # Business logic modules
│   ├── customers/         # Customer registry
│   ├── groups/            # Telegram groups & access control
│   ├── imports/           # CSV bulk import
│   └── mapping/           # PRTG mapping logic
├── integrations/          # External system adapters
│   ├── telegram/          # Telegraf bot, commands, UI
│   ├── prtg/              # PRTG API client (placeholder)
│   └── icmp/              # Ping client (placeholder)
├── infrastructure/        # Database, migrations
└── shared/                # Shared utilities
```

## Roadmap

- **V1** Foundation (complete) - Architecture, DB, basic commands
- **V2** Customer Registry + CSV Import (complete)
- **V3** Telegram Groups & Access Control (complete)
- **V3.2** Security Hotfix & Freeze Verification (complete)
- **V4** PRTG Inventory & Mapping
- **V5** Status Commands
- **V6** Monitoring Engine
- **V7** Alert Routing
- **V8** Production Hardening & Handover (complete)
- **V8.1** Customer Deletion Feature (complete)
- **V8.2** Interactive Group Alerts Menu (complete)

### Test Suite

- Total: **997** tests (V8.2 added 24 new tests)
- Passed: **994**
- Failed: **3** (pre-existing, unrelated to V8):
  - `tests/integration/imports/pelanggan-import.test.ts` — 1 failure (CSV fixture encoding)
  - `tests/integration/telegram/status/status-routing.test.ts` — 2 failures (stale DOWN data assertions)
- Skipped: **0**

## Security

- All secrets via environment variables only
- No credentials in logs or source code
- Admin authorization by Telegram User ID only (not usernames)
- SQL parameterized queries
- Input validation with Zod

## License

MIT