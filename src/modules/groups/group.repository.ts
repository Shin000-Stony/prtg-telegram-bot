import { getDatabase, runInTransaction } from '../../infrastructure/database/database';
import type { TelegramGroup, GroupFilters, GroupListResult, GroupCustomerAccess, AssignCustomerInput, UpdateAccessInput, SetAlertInput } from './group.types';
import { AppError } from '../../core/errors/app-error';
import { getLogger } from '../../core/logger';
import { getConfig } from '../../config/env';

function rowToGroup(row: Record<string, unknown>): TelegramGroup {
  return {
    chatId: row.chat_id as string,
    title: row.title as string | null,
    enabled: (row.enabled as number) === 1,
    registeredAt: row.registered_at as string,
  };
}

function rowToAccess(row: Record<string, unknown>): GroupCustomerAccess {
  return {
    groupChatId: row.group_chat_id as string,
    customerId: row.customer_id as number,
    canView: (row.can_view as number) === 1,
    receiveAlerts: (row.receive_alerts as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class GroupRepository {
  private getDb() {
    return getDatabase();
  }
  private logger = getLogger().child({ module: 'GroupRepository' });

  upsert(chatId: string, title: string | null): TelegramGroup {
    const now = new Date().toISOString();
    const stmt = this.getDb().prepare(`
      INSERT INTO telegram_groups (chat_id, title, enabled, registered_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        title = excluded.title,
        enabled = 1
    `);

    stmt.run(chatId, title, now);
    return this.findByChatId(chatId)!;
  }

  findByChatId(chatId: string): TelegramGroup | null {
    const row = this.getDb().prepare('SELECT * FROM telegram_groups WHERE chat_id = ?').get(chatId) as Record<string, unknown> | undefined;
    return row ? rowToGroup(row) : null;
  }

  findAll(filters: GroupFilters = {}): GroupListResult {
    const { enabled, search, page = 1, pageSize = 20 } = filters;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (enabled !== undefined) {
      conditions.push('enabled = ?');
      params.push(enabled ? 1 : 0);
    }

    if (search) {
      conditions.push('(chat_id LIKE ? OR title LIKE ?)');
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = this.getDb().prepare(`SELECT COUNT(*) as total FROM telegram_groups ${whereClause}`);
    const total = (countStmt.get(...params) as { total: number }).total;

    const offset = (page - 1) * pageSize;
    const selectStmt = this.getDb().prepare(`
      SELECT * FROM telegram_groups ${whereClause}
      ORDER BY registered_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = selectStmt.all(...params, pageSize, offset) as Record<string, unknown>[];
    const items = rows.map(rowToGroup);

    return {
      items,
      total,
      page,
      pageSize,
      hasMore: offset + items.length < total,
    };
  }

  setEnabled(chatId: string, enabled: boolean): boolean {
    const stmt = this.getDb().prepare('UPDATE telegram_groups SET enabled = ? WHERE chat_id = ?');
    const result = stmt.run(enabled ? 1 : 0, chatId);
    return result.changes > 0;
  }

  assignCustomer(input: AssignCustomerInput): GroupCustomerAccess {
    const now = new Date().toISOString();
    const config = getConfig();
    const isGlobalGroup = config.TELEGRAM_GLOBAL_GROUP_ID && input.groupChatId === config.TELEGRAM_GLOBAL_GROUP_ID;

    // Ensure Global Group has a lightweight row in telegram_groups for FK integrity
    if (isGlobalGroup) {
      this.getDb().prepare(`
        INSERT INTO telegram_groups (chat_id, title, enabled, registered_at)
        VALUES (?, 'Global Group', 1, ?)
        ON CONFLICT(chat_id) DO NOTHING
      `).run(config.TELEGRAM_GLOBAL_GROUP_ID!, now);
    }

    const stmt = this.getDb().prepare(`
      INSERT INTO group_customer_access (group_chat_id, customer_id, can_view, receive_alerts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_chat_id, customer_id) DO UPDATE SET
        can_view = excluded.can_view,
        receive_alerts = CASE WHEN excluded.receive_alerts = 1 THEN 1 ELSE receive_alerts END,
        updated_at = excluded.updated_at
    `);

    try {
      stmt.run(
        input.groupChatId,
        input.customerId,
        input.canView ?? true ? 1 : 0,
        input.receiveAlerts ?? false ? 1 : 0,
        now,
        now
      );
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw AppError.validation('Invalid group or customer reference', { groupChatId: input.groupChatId, customerId: input.customerId });
      }
      throw AppError.database('Failed to assign customer to group', { originalError: String(error) });
    }

    return this.getAccess(input.groupChatId, input.customerId)!;
  }

  getAccess(groupChatId: string, customerId: number): GroupCustomerAccess | null {
    const row = this.getDb().prepare(
      'SELECT * FROM group_customer_access WHERE group_chat_id = ? AND customer_id = ?'
    ).get(groupChatId, customerId) as Record<string, unknown> | undefined;
    return row ? rowToAccess(row) : null;
  }

  getAccessForGroup(groupChatId: string): GroupCustomerAccess[] {
    const rows = this.getDb().prepare(
      'SELECT * FROM group_customer_access WHERE group_chat_id = ? ORDER BY customer_id'
    ).all(groupChatId) as Record<string, unknown>[];
    return rows.map(rowToAccess);
  }

  getAccessForCustomer(customerId: number): GroupCustomerAccess[] {
    const rows = this.getDb().prepare(
      'SELECT * FROM group_customer_access WHERE customer_id = ? ORDER BY group_chat_id'
    ).all(customerId) as Record<string, unknown>[];
    return rows.map(rowToAccess);
  }

  updateAccess(groupChatId: string, customerId: number, input: UpdateAccessInput): GroupCustomerAccess | null {
    const existing = this.getAccess(groupChatId, customerId);
    if (!existing) {
      return null;
    }

    const newCanView = input.canView !== undefined ? input.canView : existing.canView;
    const newReceiveAlerts = input.receiveAlerts !== undefined ? input.receiveAlerts : existing.receiveAlerts;

    // Zero/zero cleanup: if both flags are false, remove the access row
    if (!newCanView && !newReceiveAlerts) {
      this.removeAccess(groupChatId, customerId);
      return null;
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.canView !== undefined) {
      updates.push('can_view = ?');
      params.push(input.canView ? 1 : 0);
    }
    if (input.receiveAlerts !== undefined) {
      updates.push('receive_alerts = ?');
      params.push(input.receiveAlerts ? 1 : 0);
    }

    if (updates.length === 0) {
      return existing;
    }

    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(groupChatId, customerId);

    const stmt = this.getDb().prepare(`UPDATE group_customer_access SET ${updates.join(', ')} WHERE group_chat_id = ? AND customer_id = ?`);
    stmt.run(...params);

    return this.getAccess(groupChatId, customerId);
  }

  removeAccess(groupChatId: string, customerId: number): boolean {
    const stmt = this.getDb().prepare('DELETE FROM group_customer_access WHERE group_chat_id = ? AND customer_id = ?');
    const result = stmt.run(groupChatId, customerId);
    return result.changes > 0;
  }

  getCustomerIdsWithAccess(groupChatId: string, receiveAlertsOnly = false): number[] {
    let sql = 'SELECT customer_id FROM group_customer_access WHERE group_chat_id = ?';
    if (receiveAlertsOnly) {
      sql += ' AND receive_alerts = 1';
    } else {
      sql += ' AND can_view = 1';
    }
    const rows = this.getDb().prepare(sql).all(groupChatId) as { customer_id: number }[];
    return rows.map((r) => r.customer_id);
  }

  setAlertSubscription(input: SetAlertInput): GroupCustomerAccess {
    const now = new Date().toISOString();
    const config = getConfig();
    const isGlobalGroup = config.TELEGRAM_GLOBAL_GROUP_ID && input.groupChatId === config.TELEGRAM_GLOBAL_GROUP_ID;

    // Ensure Global Group has a lightweight row in telegram_groups for FK integrity
    if (isGlobalGroup) {
      this.getDb().prepare(`
        INSERT INTO telegram_groups (chat_id, title, enabled, registered_at)
        VALUES (?, 'Global Group', 1, ?)
        ON CONFLICT(chat_id) DO NOTHING
      `).run(config.TELEGRAM_GLOBAL_GROUP_ID!, now);
    }

    if (isGlobalGroup) {
      // For Global Group, allow alert subscription without can_view requirement
      const stmt = this.getDb().prepare(`
        INSERT INTO group_customer_access (group_chat_id, customer_id, can_view, receive_alerts, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?, ?)
        ON CONFLICT(group_chat_id, customer_id) DO UPDATE SET
          receive_alerts = excluded.receive_alerts,
          updated_at = excluded.updated_at
      `);

      try {
        stmt.run(
          input.groupChatId,
          input.customerId,
          input.receiveAlerts ? 1 : 0,
          now,
          now
        );
      } catch (error) {
        const err = error as Error & { code?: string };
        if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
          throw AppError.validation('Invalid group or customer reference', { groupChatId: input.groupChatId, customerId: input.customerId });
        }
        throw AppError.database('Failed to set alert subscription', { originalError: String(error) });
      }
    } else {
      // For ordinary groups, allow alert subscription without can_view requirement
      const stmt = this.getDb().prepare(`
        INSERT INTO group_customer_access (group_chat_id, customer_id, can_view, receive_alerts, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?, ?)
        ON CONFLICT(group_chat_id, customer_id) DO UPDATE SET
          receive_alerts = excluded.receive_alerts,
          updated_at = excluded.updated_at
      `);

      try {
        stmt.run(
          input.groupChatId,
          input.customerId,
          input.receiveAlerts ? 1 : 0,
          now,
          now
        );
      } catch (error) {
        const err = error as Error & { code?: string };
        if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
          throw AppError.validation('Invalid group or customer reference', { groupChatId: input.groupChatId, customerId: input.customerId });
        }
        throw AppError.database('Failed to set alert subscription', { originalError: String(error) });
      }
    }

    return this.getAccess(input.groupChatId, input.customerId)!;
  }

  getGroupWithCustomerDetails(groupChatId: string, includeDisabled = false, filterCanView = false): Array<{ customerId: number; clientId: string; name: string; monitorType: string; canView: boolean; receiveAlerts: boolean; enabled: boolean }> {
    const config = getConfig();
    const isGlobalGroup = config.TELEGRAM_GLOBAL_GROUP_ID && groupChatId === config.TELEGRAM_GLOBAL_GROUP_ID;

    if (isGlobalGroup) {
       // For Global Group, return all customers with default visibility=true and alert state from explicit subscriptions
       // When includeDisabled is false, only return enabled customers (default behavior)
       const enabledFilter = includeDisabled ? '' : 'WHERE c.enabled = 1';
       const rows = this.getDb().prepare(`
         SELECT c.id as customer_id, c.client_id, c.name, c.monitor_type,
                COALESCE(c.enabled, 0) as enabled,
                COALESCE(gca.receive_alerts, 0) as receive_alerts
         FROM customers c
         LEFT JOIN group_customer_access gca ON gca.customer_id = c.id AND gca.group_chat_id = ?
         ${enabledFilter}
         ORDER BY c.client_id
       `).all(config.TELEGRAM_GLOBAL_GROUP_ID!) as Record<string, unknown>[];
      
      return rows.map(row => ({
        customerId: row.customer_id as number,
        clientId: row.client_id as string,
        name: row.name as string,
        monitorType: row.monitor_type as string,
        canView: true, // Global Group sees all customers
        enabled: (row.enabled as number) === 1,
        receiveAlerts: (row.receive_alerts as number) === 1,
      }));
    }

       // For ordinary groups, only return customers with explicit access rows
       // filterCanView=true restricts to can_view=1 customers only (used by alert menu)
       const visibilityFilter = filterCanView ? 'AND gca.can_view = 1' : '';
       const rows = this.getDb().prepare(`
         SELECT gca.customer_id, gca.can_view, gca.receive_alerts,
                c.client_id, c.name, c.monitor_type, c.enabled
       FROM group_customer_access gca
       JOIN customers c ON c.id = gca.customer_id
       WHERE gca.group_chat_id = ? ${visibilityFilter}
       ORDER BY c.client_id
     `).all(groupChatId) as Record<string, unknown>[];
    
         return rows.map(row => ({
      customerId: row.customer_id as number,
      clientId: row.client_id as string,
      name: row.name as string,
      monitorType: row.monitor_type as string,
      canView: (row.can_view as number) === 1,
      enabled: (row.enabled as number) === 1,
      receiveAlerts: (row.receive_alerts as number) === 1,
    }));
  }

  bulkSetAlertSubscription(groupChatId: string, customerIds: number[], receiveAlerts: boolean): number {
    return runInTransaction((db) => {
      const now = new Date().toISOString();
      const targetFlag = receiveAlerts ? 1 : 0;
      const config = getConfig();
      const isGlobalGroup = config.TELEGRAM_GLOBAL_GROUP_ID && groupChatId === config.TELEGRAM_GLOBAL_GROUP_ID;
      let changed = 0;

      if (isGlobalGroup) {
        db.prepare(`
          INSERT INTO telegram_groups (chat_id, title, enabled, registered_at)
          VALUES (?, 'Global Group', 1, ?)
          ON CONFLICT(chat_id) DO NOTHING
        `).run(groupChatId, now);
      }

      const customerCheckStmt = db.prepare(
        isGlobalGroup
          ? 'SELECT 1 FROM customers WHERE id = ?'
          : 'SELECT can_view FROM group_customer_access WHERE group_chat_id = ? AND customer_id = ? AND can_view = 1'
      );

      for (const customerId of customerIds) {
        const row = isGlobalGroup
          ? customerCheckStmt.get(customerId) as { '1': number } | undefined
          : customerCheckStmt.get(groupChatId, customerId) as { can_view: number } | undefined;
        if (!row) {
          throw AppError.validation('Bulk target out of scope or missing', { groupChatId, customerId });
        }
      }

      const selectStmt = db.prepare(
        'SELECT receive_alerts FROM group_customer_access WHERE group_chat_id = ? AND customer_id = ?'
      );
      const updateStmt = db.prepare(
        'UPDATE group_customer_access SET receive_alerts = ?, updated_at = ? WHERE group_chat_id = ? AND customer_id = ?'
      );
      const insertStmt = db.prepare(
        'INSERT INTO group_customer_access (group_chat_id, customer_id, can_view, receive_alerts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      );

      for (const customerId of customerIds) {
        const current = selectStmt.get(groupChatId, customerId) as { receive_alerts: number } | undefined;

        if (!current) {
          if (isGlobalGroup && receiveAlerts) {
            insertStmt.run(groupChatId, customerId, 0, 1, now, now);
            changed++;
          }
          continue;
        }

        if (current.receive_alerts === targetFlag) {
          continue;
        }

        const result = updateStmt.run(targetFlag, now, groupChatId, customerId);
        changed += result.changes;
      }

      return changed;
    });
  }

  removeGroup(chatId: string): boolean {
    const stmt = this.getDb().prepare('DELETE FROM telegram_groups WHERE chat_id = ?');
    const result = stmt.run(chatId);
    return result.changes > 0;
  }
}

export const groupRepository = new GroupRepository();