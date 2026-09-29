import { getDatabase, runInTransaction } from '../../infrastructure/database/database';
import type { Customer, CreateCustomerInput, UpdateCustomerInput, CustomerFilters, CustomerListResult } from './customer.types';
import { AppError } from '../../core/errors/app-error';
import { getLogger } from '../../core/logger';

function rowToCustomer(row: Record<string, unknown>): Customer {
  return {
    id: row.id as number,
    clientId: row.client_id as string,
    name: row.name as string,
    monitorType: row.monitor_type as Customer['monitorType'],
    pingHost: row.ping_host as string | null,
    enabled: (row.enabled as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class CustomerRepository {
  private getDb() {
    return getDatabase();
  }
  private logger = getLogger().child({ module: 'CustomerRepository' });

  private escapeLike(value: string): string {
    return value.replace(/[%_]/g, (ch) => '\\' + ch);
  }


  create(input: CreateCustomerInput): Customer {
    const now = new Date().toISOString();
    const stmt = this.getDb().prepare(`
      INSERT INTO customers (client_id, name, monitor_type, ping_host, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      const result = stmt.run(
        input.clientId,
        input.name,
        input.monitorType,
        input.pingHost ?? null,
        input.enabled ?? true ? 1 : 0,
        now,
        now
      );

      return this.findById(result.lastInsertRowid as number)!;
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw AppError.validation('Client ID already exists', { clientId: input.clientId });
      }
      this.logger.error({ err: error, input }, 'Failed to create customer');
      throw AppError.database('Failed to create customer', { originalError: String(error) });
    }
  }

  findById(id: number): Customer | null {
    const row = this.getDb().prepare('SELECT * FROM customers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToCustomer(row) : null;
  }

  findByClientId(clientId: string): Customer | null {
    const row = this.getDb().prepare('SELECT * FROM customers WHERE client_id = ?').get(clientId) as Record<string, unknown> | undefined;
    return row ? rowToCustomer(row) : null;
  }

  findAll(filters: CustomerFilters = {}): CustomerListResult {
    const {
      enabled,
      monitorType,
      search,
      page = 1,
      pageSize = 20,
    } = filters;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (enabled !== undefined) {
      conditions.push('enabled = ?');
      params.push(enabled ? 1 : 0);
    }

    if (monitorType) {
      conditions.push('monitor_type = ?');
      params.push(monitorType);
    }

    if (search) {
      conditions.push(`(INSTR(LOWER(client_id), LOWER(?)) > 0 OR INSTR(LOWER(name), LOWER(?)) > 0)`);
      params.push(search, search);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = this.getDb().prepare(`SELECT COUNT(*) as total FROM customers ${whereClause}`);
    const total = (countStmt.get(...params) as { total: number }).total;

    const offset = (page - 1) * pageSize;
    const selectStmt = this.getDb().prepare(`
      SELECT * FROM customers ${whereClause}
      ORDER BY name ASC, id ASC
      LIMIT ? OFFSET ?
    `);

    const rows = selectStmt.all(...params, pageSize, offset) as Record<string, unknown>[];
    const items = rows.map(rowToCustomer);

    return {
      items,
      total,
      page,
      pageSize,
      hasMore: offset + items.length < total,
    };
  }

  findAllUnpaged(filters: CustomerFilters = {}): Customer[] {
    const { enabled, monitorType, search } = filters;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (enabled !== undefined) {
      conditions.push('enabled = ?');
      params.push(enabled ? 1 : 0);
    }

    if (monitorType) {
      conditions.push('monitor_type = ?');
      params.push(monitorType);
    }

    if (search) {
      conditions.push(`(INSTR(LOWER(client_id), LOWER(?)) > 0 OR INSTR(LOWER(name), LOWER(?)) > 0)`);
      params.push(search, search);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const selectStmt = this.getDb().prepare(`
      SELECT * FROM customers ${whereClause}
      ORDER BY name ASC, id ASC
    `);

    const rows = selectStmt.all(...params) as Record<string, unknown>[];
    return rows.map(rowToCustomer);
  }

  update(id: number, input: UpdateCustomerInput): Customer | null {
    const existing = this.findById(id);
    if (!existing) {
      return null;
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) {
      updates.push('name = ?');
      params.push(input.name);
    }
    if (input.monitorType !== undefined) {
      updates.push('monitor_type = ?');
      params.push(input.monitorType);
    }
    if (input.pingHost !== undefined) {
      updates.push('ping_host = ?');
      params.push(input.pingHost);
    }
    if (input.enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(input.enabled ? 1 : 0);
    }

    if (updates.length === 0) {
      return existing;
    }

    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    const stmt = this.getDb().prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`);
    stmt.run(...params);

    return this.findById(id);
  }

  delete(id: number): boolean {
    const stmt = this.getDb().prepare('DELETE FROM customers WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  bulkCreate(customers: CreateCustomerInput[]): Customer[] {
    return runInTransaction((db) => {
      const stmt = db.prepare(`
        INSERT INTO customers (client_id, name, monitor_type, ping_host, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const now = new Date().toISOString();
      const created: Customer[] = [];

      for (const input of customers) {
        const result = stmt.run(
          input.clientId,
          input.name,
          input.monitorType,
          input.pingHost ?? null,
          input.enabled ?? true ? 1 : 0,
          now,
          now
        );
        const customer = this.findById(result.lastInsertRowid as number);
        if (customer) {
          created.push(customer);
        }
      }

      return created;
    });
  }

  count(): number {
    const row = this.getDb().prepare('SELECT COUNT(*) as total FROM customers').get() as { total: number };
    return row.total;
  }

  countByMonitorType(): Record<string, number> {
    const rows = this.getDb().prepare('SELECT monitor_type, COUNT(*) as count FROM customers GROUP BY monitor_type').all() as { monitor_type: string; count: number }[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.monitor_type] = row.count;
    }
    return result;
  }
}

export const customerRepository = new CustomerRepository();