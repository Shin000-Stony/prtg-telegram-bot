import { z } from 'zod';

export type PrtgTable = 'sensors' | 'devices';

export interface PrtgRawRow {
  [key: string]: unknown;
}

export const positiveSafeInt = (field: string) =>
  z.preprocess(
    (val) => {
      if (typeof val === 'boolean' || typeof val === 'function' || typeof val === 'symbol' || val === '') {
        return NaN;
      }
      const str = String(val).trim();
      if (!/^[0-9]+$/.test(str)) {
        return NaN;
      }
      const num = Number(str);
      return Number.isSafeInteger(num) && num > 0 ? num : NaN;
    },
    z.number({ invalid_type_error: `${field} must be a positive safe integer` }).int().positive({ message: `${field} must be a positive safe integer` })
  );

export const PrtgSensorRawSchema = z.object({
  objid: positiveSafeInt('objid'),
  device: z.string().min(1, 'device is required'),
  sensor: z.string().min(1, 'sensor is required'),
  type: z.string().min(1, 'type is required'),
  status_raw: z.union([z.number().int(), z.string()]).nullable().optional(),
  status: z.union([z.number().int(), z.string()]).nullable().optional(),
  statusmessage: z.preprocess(
    (val) => (val === null || val === undefined || val === '' ? null : String(val)),
    z.string().nullable()
  ),
  lastvalue: z.preprocess(
    (val) => (val === null || val === undefined || val === '' ? null : String(val)),
    z.string().nullable()
  ),
  lastup: z.preprocess(
    (val) => (val === null || val === undefined || val === '' ? null : String(val)),
    z.string().nullable()
  ),
  lastdown: z.preprocess(
    (val) => (val === null || val === undefined || val === '' ? null : String(val)),
    z.string().nullable()
  ),
  host: z.preprocess(
    (val) => (val === null || val === undefined || val === '' ? null : String(val)),
    z.string().nullable().optional()
  ),
});

export const PrtgDeviceRawSchema = z.object({
  objid: positiveSafeInt('objid'),
  device: z.string().min(1, 'device is required'),
  host: z.preprocess(
    (val) => (val === null || val === undefined || val === '' ? null : String(val)),
    z.string().nullable().optional()
  ),
  status_raw: z.union([z.number().int(), z.string()]).nullable().optional(),
  status: z.union([z.number().int(), z.string()]).nullable().optional(),
  name: z.preprocess(
    (val) => (val === null || val === undefined || val === '' ? null : String(val)),
    z.string().nullable().optional()
  ),
});

export type PrtgSensorRaw = z.infer<typeof PrtgSensorRawSchema>;
export type PrtgDeviceRaw = z.infer<typeof PrtgDeviceRawSchema>;

export interface PrtgSensor {
  objectId: number;
  deviceName: string;
  sensorName: string;
  sensorType: string;
  statusRaw: number | null;
  statusDisplay: string | null;
  statusMessage: string | null;
  lastValue: string | null;
  lastUp: string | null;
  lastDown: string | null;
}

export interface PrtgDevice {
  objectId: number;
  deviceName: string;
  host: string | null;
  statusRaw: number | null;
  statusDisplay: string | null;
}

export interface PrtgInventorySnapshot {
  sensors: PrtgSensor[];
  devices: PrtgDevice[];
  generation: number;
  fetchedAt: string;
}

export interface PrtgClientConfig {
  baseUrl: string;
  username: string;
  passhash: string;
  rejectUnauthorized: boolean;
}

export interface PrtgObjectCandidate {
  objectId: number;
  deviceName: string;
  sensorName: string;
  sensorType: string;
}

export interface PrtgTransport {
  fetchPage(table: PrtgTable, start: number, count: number, signal?: AbortSignal): Promise<PrtgPageResult>;
}

export interface PrtgPageResult {
  rows: unknown[];
  total: number | null;
}