# Development Guide

## Folder Conventions

```
src/
├── config/           # Configuration (env validation, constants)
├── core/             # Cross-cutting: errors, logger, types
├── modules/          # Business domains (one folder per domain)
│   └── <domain>/
│       ├── *.types.ts       # Domain types, interfaces
│       ├── *.validators.ts  # Zod schemas, validation fns
│       ├── *.repository.ts  # Database access
│       └── *.service.ts     # Business logic
├── integrations/     # External adapters
│   ├── telegram/
│   │   ├── bot.ts           # Telegraf setup, middleware
│   │   ├── context.ts       # Context helpers
│   │   ├── middleware/      # Auth, error handling
│   │   ├── commands/        # One file per command
│   │   ├── handlers/        # Document/message handlers
│   │   └── ui/              # Formatters, keyboards
│   ├── prtg/
│   └── icmp/
├── infrastructure/   # Technical: database, migrations
└── shared/           # Pure utilities (no internal deps)
```

## Adding a Command

1. **Create command file** in `src/integrations/telegram/commands/`:
```typescript
// mycommand.command.ts
import { BotContext } from '../bot';
import { formatSuccess } from '../ui/messages';

export async function myCommand(ctx: BotContext): Promise<void> {
  await ctx.reply(formatSuccess('Done!'));
}
```

2. **Register in `src/app.ts`**:
```typescript
import { myCommand } from './integrations/telegram/commands/mycommand.command';

bot.command('mycommand', myCommand);
```

3. **Add middleware if needed**:
```typescript
import { requireAdmin } from './integrations/telegram/bot';

bot.command('mycommand', requireAdmin(), myCommand);
```

4. **Write tests** in `tests/unit/integrations/telegram/commands/`

## Adding a Document/Message Handler

1. **Create handler file** in `src/integrations/telegram/handlers/`:
```typescript
// myhandler.handler.ts
import type { BotContext } from '../bot';
import { myService } from '../../modules/my/my.service';
import { formatSuccess } from '../ui/messages';

export async function handleMyDocument(ctx: BotContext): Promise<void> {
  // validation, processing, response
}
```

2. **Register in `src/app.ts`**:
```typescript
import { handleMyDocument } from './integrations/telegram/handlers/myhandler.handler';

bot.on('document', handleMyDocument);
bot.action(/my_action:.+/, handleMyAction);
```

## Adding a Repository/Service

### Repository (`src/modules/<domain>/<domain>.repository.ts`)

```typescript
import { getDatabase } from '../../infrastructure/database/database';
import { MyEntity, CreateMyEntityInput } from './myentity.types';
import { AppError } from '../../core/errors/app-error';

export class MyEntityRepository {
  private db = getDatabase();

  create(input: CreateMyEntityInput): MyEntity { ... }
  findById(id: number): MyEntity | null { ... }
  // ... other methods
}

export const myEntityRepository = new MyEntityRepository();
```

### Service (`src/modules/<domain>/<domain>.service.ts`)

```typescript
import { myEntityRepository } from './myentity.repository';
import { validateCreateMyEntity } from './myentity.validators';
import { MyEntity, CreateMyEntityInput } from './myentity.types';
import { AppError } from '../../core/errors/app-error';

export class MyEntityService {
  create(input: unknown): MyEntity {
    const validated = validateCreateMyEntity(input);
    // business rules
    return myEntityRepository.create(validated);
  }
  // ... other methods
}

export const myEntityService = new MyEntityService();
```

### Validators (`src/modules/<domain>/<domain>.validators.ts`)

```typescript
import { z } from 'zod';

export const createMyEntitySchema = z.object({
  name: z.string().min(1).max(100),
  // ...
});

export type CreateMyEntityInput = z.infer<typeof createMyEntitySchema>;

export function validateCreateMyEntity(input: unknown): CreateMyEntityInput {
  return createMyEntitySchema.parse(input);
}
```

## Writing Migrations

1. **Create migration file**: `src/infrastructure/database/migrations/002_description.sql`
2. **Use version prefix**: `002_`, `003_`, etc.
3. **Include up/down logic** (down not auto-run, but document it):
```sql
-- Version: 2
-- Name: add_customer_notes

ALTER TABLE customers ADD COLUMN notes TEXT;

-- Down (manual):
-- ALTER TABLE customers DROP COLUMN notes;
```
4. **Run**: `npm run db:migrate`

## Running Tests

```bash
# All tests
npm test

# Watch mode
npm run test:watch

# Single file
npx vitest run tests/unit/modules/customers/customer.service.test.ts

# With coverage
npx vitest run --coverage
```

### Test Structure

```
tests/
├── unit/              # Fast, isolated, mocked
│   ├── config/
│   ├── core/
│   ├── modules/
│   │   ├── customers/
│   │   ├── groups/
│   │   ├── imports/
│   │   └── mapping/
│   ├── integrations/
│   │   └── telegram/
│   │       ├── commands/
│   │       └── handlers/
│   └── shared/
├── integration/       # Real DB, real services
│   ├── database/
│   └── modules/
└── fixtures/          # Shared test data
```

### Test Patterns

**Unit test (service)**:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { customerService } from '../../../src/modules/customers/customer.service';
import { customerRepository } from '../../../src/modules/customers/customer.repository';

vi.mock('../../../src/modules/customers/customer.repository');

describe('CustomerService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('creates customer', () => {
    const mockCreate = vi.spyOn(customerRepository, 'create').mockReturnValue({
      id: 1, clientId: '123', name: 'Test', monitorType: 'prtg',
      pingHost: null, enabled: true, createdAt: '', updatedAt: ''
    });

    const result = customerService.create({ clientId: '123', name: 'Test', monitorType: 'prtg' });
    expect(result.clientId).toBe('123');
  });
});
```

**Unit test (handler with mocked Telegram context)**:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { myHandler } from '@/integrations/telegram/handlers/myhandler.handler';
import { myService } from '@/modules/my/my.service';
import { accessService } from '@/modules/groups/access.service';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';

describe('MyHandler', () => {
  beforeEach(() => {
    resetConfigForTesting();
    resetDatabaseForTesting();
    runMigrations();
  });

  function makeMockContext(overrides = {}) {
    const reply = vi.fn();
    return {
      userId: overrides.userId || 'admin1',
      chatId: overrides.chatId || '-1001234567890',
      chatType: overrides.chatType || 'supergroup',
      message: overrides.message || { text: '/mycommand' },
      reply,
    } as any;
  }

  it('handles valid input', async () => {
    const ctx = makeMockContext({ userId: 'admin1', chatId: '-1001234567890' });
    await myHandler(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Success'));
  });
});
```

**Integration test (repository)**:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDatabase, resetDatabaseForTesting } from '../../../src/infrastructure/database/database';
import { runMigrations, resetMigrationsForTesting } from '../../../src/infrastructure/database/migration-runner';
import { customerRepository } from '../../../src/modules/customers/customer.repository';

describe('CustomerRepository', () => {
  beforeEach(() => {
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
  });

  it('creates and finds customer', () => {
    const created = customerRepository.create({
      clientId: '123', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true
    });
    expect(created.id).toBe(1);

    const found = customerRepository.findById(1);
    expect(found?.clientId).toBe('123');
  });
});
```

## Handling Secrets

**NEVER:**
- Commit `.env` files
- Log tokens, passwords, passhashes
- Put secrets in test fixtures
- Use usernames for authorization

**ALWAYS:**
- Use `.env.example` for templates
- Load from `process.env` only in `src/config/env.ts`
- Use `TELEGRAM_ADMIN_IDS` (user IDs, not usernames)
- Mask secrets in logs (see `src/shared/strings.ts` → `maskSecret()`)

## Code Quality

```bash
npm run typecheck  # TypeScript strict mode
npm run lint       # ESLint
npm run build      # Full compile check
```

### TypeScript Rules

- `strict: true` in tsconfig
- Avoid `any` - use `unknown` or proper types
- Use `readonly` for immutability
- Prefer interfaces for object shapes
- Use type guards for narrowing

### ESLint Rules

- No unused variables
- No console.log (use logger)
- Prefer const over let
- No trailing commas in single-line

## Debugging

### Logger

```typescript
import { getLogger } from '../core/logger';

const logger = getLogger().child({ module: 'MyModule' });
logger.info({ key: 'value' }, 'Message');
logger.debug({ obj }, 'Debug');
logger.error({ err: error }, 'Failed');
```

### Database Inspection

```bash
# Open SQLite CLI
sqlite3 data/prtg_bot.db

# Useful queries
.tables
.schema customers
SELECT * FROM customers;
SELECT * FROM schema_migrations;
```

## Common Tasks

### Reset Database (Development)

```bash
rm data/prtg_bot.db*
npm run db:migrate
```

### Add Test Fixture

Create in `tests/fixtures/` and import:
```typescript
import { readFileSync } from 'fs';
import { join } from 'path';

const csv = readFileSync(join(__dirname, 'fixtures', 'valid.csv'), 'utf-8');
```

### Run Single Migration Manually

```bash
npx tsx -e "
import { getDatabase } from './src/infrastructure/database/database';
import { readFileSync } from 'fs';
const db = getDatabase();
const sql = readFileSync('./src/infrastructure/database/migrations/001_initial.sql', 'utf-8');
db.exec(sql);
console.log('Done');
"
```

## Git Workflow

1. Create feature branch
2. Make changes with tests
3. Run `npm run typecheck && npm run lint && npm test`
4. Commit with descriptive message
5. Push and create PR

## Useful Commands

```bash
# Type check only
npx tsc --noEmit

# Lint with auto-fix
npx eslint src --ext .ts --fix

# Run tests with UI
npx vitest --ui

# Check for circular deps
npx madge --circular --extensions ts src
```