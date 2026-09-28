import type {
  PrtgClientConfig,
  PrtgSensor,
  PrtgDevice,
  PrtgTable,
  PrtgTransport,
  PrtgSensorRaw,
  PrtgDeviceRaw,
  PrtgPageResult,
} from './prtg.types';
import { PrtgSensorRawSchema, PrtgDeviceRawSchema } from './prtg.types';
import { AppError } from '../../core/errors/app-error';
import { getLogger } from '../../core/logger';

const logger = getLogger().child({ module: 'PrtgClient' });

export const PRTG_PAGE_SIZE = 500;
export const PRTG_MAX_PAGES = 100;

export interface PrtgClientDeps {
  config: PrtgClientConfig;
  transport: PrtgTransport;
}

export class PrtgClient {
  private readonly transport: PrtgTransport;

  constructor(deps: PrtgClientDeps) {
    this.transport = deps.transport;
  }

  async fetchInventory(signal?: AbortSignal): Promise<{ sensors: PrtgSensor[]; devices: PrtgDevice[] }> {
    const sensors = await this.fetchTable('sensors', PrtgSensorRawSchema, normalizeSensor, signal);
    const devices = await this.fetchTable('devices', PrtgDeviceRawSchema, normalizeDevice, signal);
    logger.info({ sensorCount: sensors.length, deviceCount: devices.length }, 'PRTG inventory fetched');
    return { sensors, devices };
  }

  private async fetchTable<Raw, Out>(
    table: PrtgTable,
    schema: typeof PrtgSensorRawSchema | typeof PrtgDeviceRawSchema,
    normalize: (row: Raw) => Out,
    signal?: AbortSignal,
  ): Promise<Out[]> {
    const seen = new Set<number>();
    const results: Out[] = [];
    let prevLastObjid: number | null = null;
    let total: number | null = null;
    let accumulated = 0;
    let pageResult: PrtgPageResult;

    for (let page = 0; page < PRTG_MAX_PAGES; page++) {
      const start = page * PRTG_PAGE_SIZE;

      if (total === null) {
        pageResult = await this.transport.fetchPage(table, start, PRTG_PAGE_SIZE, signal);
        if (pageResult.total !== null) {
          total = pageResult.total;
          if (!results.length && pageResult.rows.length === 0 && total === 0) {
            return results;
          }
          if (total === null) {
            throw AppError.external('PRTG response missing treesize; pagination cannot proceed', { table, start });
          }
        } else if (pageResult.rows.length > 0) {
          throw AppError.external('PRTG response missing treesize; pagination cannot proceed', { table, start });
        }
      } else {
        if (accumulated >= total) {
          break;
        }
        const remaining = total - accumulated;
        if (remaining <= 0) {
          break;
        }
        const count = Math.min(PRTG_PAGE_SIZE, remaining);
        pageResult = await this.transport.fetchPage(table, start, count, signal);

        if (pageResult.total === null || pageResult.total !== total) {
          throw AppError.external('PRTG treesize changed or missing across pages', { table, start, expected: total, received: pageResult.total });
        }

        if (pageResult.rows.length > remaining) {
          throw AppError.external('PRTG returned more rows than remaining total', { table, start, received: pageResult.rows.length, remaining });
        }
      }

      accumulated += pageResult.rows.length;

      if (total !== null && pageResult.rows.length === 0 && accumulated < total) {
        throw AppError.external('PRTG returned empty page before reaching total', { table, start, received: accumulated, total });
      }

      if (pageResult.rows.length > 0) {
        const firstObjid = Number((pageResult.rows[0] as { objid: number }).objid);
        const lastObjid = Number((pageResult.rows[pageResult.rows.length - 1] as { objid: number }).objid);
        if (prevLastObjid !== null && firstObjid <= prevLastObjid) {
          throw AppError.external('PRTG pagination did not advance; repeated/overlapping object ID window across pages', { table, start, prevLastObjid, firstObjid });
        }
        prevLastObjid = lastObjid;
      }

      for (let i = 0; i < pageResult.rows.length; i++) {
        const raw = pageResult.rows[i];
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          logger.warn({ table, start, index: i, issues: parsed.error.issues.map((is) => is.path) }, 'Invalid PRTG row rejected');
          throw AppError.external(`Invalid ${table} row received from PRTG API`, { table });
        }
        const row = parsed.data as unknown as Raw & { objid: number };
        if (seen.has(row.objid)) {
          throw AppError.external('Duplicate object ID in PRTG response', { table, objectId: row.objid });
        }
        seen.add(row.objid);
        results.push(normalize(row));
      }

      if (total !== null && accumulated >= total) {
        return results;
      }

      if (total === null && pageResult.rows.length < PRTG_PAGE_SIZE) {
        break;
      }
    }

    if (total === null) {
      throw AppError.external('PRTG response missing treesize; pagination cannot proceed', { table });
    }

    if (accumulated < total) {
      throw AppError.external('PRTG pagination stopped before reaching total', { table, received: accumulated, total });
    }

    return results;
  }
}

function parseRawStatus(val: number | string | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Number.isInteger(val) ? val : null;
  const num = Number(val);
  return Number.isInteger(num) ? num : null;
}

function parseDisplayStatus(val: number | string | null | undefined): string | null {
  if (val === null || val === undefined) return null;
  return String(val).trim();
}

function normalizeSensor(row: PrtgSensorRaw): PrtgSensor {
  return {
    objectId: row.objid,
    deviceName: row.device,
    sensorName: row.sensor,
    sensorType: row.type,
    statusRaw: parseRawStatus((row as PrtgSensorRaw & { status_raw?: number | string | null }).status_raw ?? row.status),
    statusDisplay: parseDisplayStatus(row.status),
    statusMessage: row.statusmessage ?? null,
    lastValue: row.lastvalue ?? null,
    lastUp: row.lastup ?? null,
    lastDown: row.lastdown ?? null,
  };
}

function normalizeDevice(row: PrtgDeviceRaw): PrtgDevice {
  return {
    objectId: row.objid,
    deviceName: row.device,
    host: row.host ?? null,
    statusRaw: parseRawStatus((row as PrtgDeviceRaw & { status_raw?: number | string | null }).status_raw ?? row.status),
    statusDisplay: parseDisplayStatus(row.status),
  };
}

export function createPrtgClient(deps: PrtgClientDeps): PrtgClient {
  return new PrtgClient(deps);
}