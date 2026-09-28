import { getDatabase, runInTransaction } from '../../infrastructure/database/database';
import type { PrtgMapping, CreateMappingInput, UpdateMappingInput } from './mapping.types';
import { AppError } from '../../core/errors/app-error';
import { getLogger } from '../../core/logger';

function rowToMapping(row: Record<string, unknown>): PrtgMapping {
  return {
    id: row.id as number,
    customerId: row.customer_id as number,
    prtgObjectId: row.prtg_object_id as number,
    prtgDeviceName: row.prtg_device_name as string | null,
    prtgSensorName: row.prtg_sensor_name as string | null,
    mappingMethod: row.mapping_method as PrtgMapping['mappingMethod'],
    confidence: row.confidence as number | null,
    verified: (row.verified as number) === 1,
    mappedByTelegramId: row.mapped_by_telegram_id as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class MappingRepository {
  private getDb() {
    return getDatabase();
  }
  private logger = getLogger().child({ module: 'MappingRepository' });

  create(input: CreateMappingInput): PrtgMapping {
    const now = new Date().toISOString();
    const stmt = this.getDb().prepare(`
      INSERT INTO prtg_mappings (customer_id, prtg_object_id, prtg_device_name, prtg_sensor_name, mapping_method, confidence, verified, mapped_by_telegram_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      const result = stmt.run(
        input.customerId,
        input.prtgObjectId,
        input.prtgDeviceName ?? null,
        input.prtgSensorName ?? null,
        input.mappingMethod,
        input.confidence ?? null,
        input.verified ?? false ? 1 : 0,
        input.mappedByTelegramId ?? null,
        now,
        now
      );

      return this.findById(result.lastInsertRowid as number)!;
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        if (err.message.includes('prtg_object_id')) {
          throw AppError.validation('PRTG sensor already mapped to another customer', { prtgObjectId: input.prtgObjectId });
        }
        throw AppError.validation('Customer already has a PRTG mapping', { customerId: input.customerId });
      }
      if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw AppError.validation('Invalid customer reference', { customerId: input.customerId });
      }
      this.logger.error({ err: error, input }, 'Failed to create mapping');
      throw AppError.database('Failed to create mapping', { originalError: String(error) });
    }
  }

  findById(id: number): PrtgMapping | null {
    const row = this.getDb().prepare('SELECT * FROM prtg_mappings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToMapping(row) : null;
  }

  findByCustomerId(customerId: number): PrtgMapping | null {
    const row = this.getDb().prepare('SELECT * FROM prtg_mappings WHERE customer_id = ?').get(customerId) as Record<string, unknown> | undefined;
    return row ? rowToMapping(row) : null;
  }

  findByPrtgObjectId(prtgObjectId: number): PrtgMapping | null {
    const row = this.getDb().prepare('SELECT * FROM prtg_mappings WHERE prtg_object_id = ?').get(prtgObjectId) as Record<string, unknown> | undefined;
    return row ? rowToMapping(row) : null;
  }

  existsByCustomerId(customerId: number): boolean {
    const row = this.getDb().prepare('SELECT 1 FROM prtg_mappings WHERE customer_id = ? LIMIT 1').get(customerId);
    return !!row;
  }

  existsByObjectId(prtgObjectId: number): boolean {
    const row = this.getDb().prepare('SELECT 1 FROM prtg_mappings WHERE prtg_object_id = ? LIMIT 1').get(prtgObjectId);
    return !!row;
  }

  findAllVerified(): PrtgMapping[] {
    const rows = this.getDb().prepare('SELECT * FROM prtg_mappings WHERE verified = 1').all() as Record<string, unknown>[];
    return rows.map(rowToMapping);
  }

  findAllWithCustomer(): Array<PrtgMapping & { clientId: string; customerName: string }> {
    const rows = this.getDb().prepare(`
      SELECT m.*, c.client_id, c.name as customer_name
      FROM prtg_mappings m
      JOIN customers c ON c.id = m.customer_id
    `).all() as Record<string, unknown>[];
    return rows.map(row => ({
      ...rowToMapping(row),
      clientId: row.client_id as string,
      customerName: row.customer_name as string,
    }));
  }

  findAll(): PrtgMapping[] {
    const rows = this.getDb().prepare('SELECT * FROM prtg_mappings').all() as Record<string, unknown>[];
    return rows.map(rowToMapping);
  }

  update(id: number, input: UpdateMappingInput): PrtgMapping | null {
    const existing = this.findById(id);
    if (!existing) {
      return null;
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.prtgObjectId !== undefined) {
      updates.push('prtg_object_id = ?');
      params.push(input.prtgObjectId);
    }
    if (input.prtgDeviceName !== undefined) {
      updates.push('prtg_device_name = ?');
      params.push(input.prtgDeviceName);
    }
    if (input.prtgSensorName !== undefined) {
      updates.push('prtg_sensor_name = ?');
      params.push(input.prtgSensorName);
    }
    if (input.mappingMethod !== undefined) {
      updates.push('mapping_method = ?');
      params.push(input.mappingMethod);
    }
    if (input.confidence !== undefined) {
      updates.push('confidence = ?');
      params.push(input.confidence);
    }
    if (input.verified !== undefined) {
      updates.push('verified = ?');
      params.push(input.verified ? 1 : 0);
    }
    if (input.mappedByTelegramId !== undefined) {
      updates.push('mapped_by_telegram_id = ?');
      params.push(input.mappedByTelegramId);
    }

    if (updates.length === 0) {
      return existing;
    }

    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    const stmt = this.getDb().prepare(`UPDATE prtg_mappings SET ${updates.join(', ')} WHERE id = ?`);
    stmt.run(...params);

    return this.findById(id);
  }

  deleteById(id: number): boolean {
    const stmt = this.getDb().prepare('DELETE FROM prtg_mappings WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteByCustomerId(customerId: number): boolean {
    const stmt = this.getDb().prepare('DELETE FROM prtg_mappings WHERE customer_id = ?');
    const result = stmt.run(customerId);
    return result.changes > 0;
  }

  createInTransaction(inputs: CreateMappingInput[]): PrtgMapping[] {
    return runInTransaction((db) => {
      const stmt = db.prepare(`
        INSERT INTO prtg_mappings (customer_id, prtg_object_id, prtg_device_name, prtg_sensor_name, mapping_method, confidence, verified, mapped_by_telegram_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      const created: PrtgMapping[] = [];

      for (const input of inputs) {
        const result = stmt.run(
          input.customerId,
          input.prtgObjectId,
          input.prtgDeviceName ?? null,
          input.prtgSensorName ?? null,
          input.mappingMethod,
          input.confidence ?? null,
          input.verified ?? false ? 1 : 0,
          input.mappedByTelegramId ?? null,
          now,
          now
        );
        const mapping = this.findById(result.lastInsertRowid as number);
        if (mapping) {
          created.push(mapping);
        }
      }

      return created;
    });
  }

  count(): number {
    const row = this.getDb().prepare('SELECT COUNT(*) as total FROM prtg_mappings').get() as { total: number };
    return row.total;
  }

  countVerified(): number {
    const row = this.getDb().prepare('SELECT COUNT(*) as total FROM prtg_mappings WHERE verified = 1').get() as { total: number };
    return row.total;
  }
}

export const mappingRepository = new MappingRepository();