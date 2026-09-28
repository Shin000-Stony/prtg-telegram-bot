import type { MonitorType } from '../../config/constants';

export interface CsvImportRow {
  clientId: string;
  name: string;
  monitorType: MonitorType;
  pingHost: string | null;
  rowNumber: number;
}

export type ValidatedCsvRow = CsvImportRow;

export interface CsvImportResult {
  valid: CsvImportRow[];
  errors: CsvImportError[];
  totalRows: number;
  validCount: number;
  errorCount: number;
  duplicateCount: number;
}

export interface CsvImportError {
  rowNumber: number;
  field: string;
  message: string;
  value: string;
}

export interface CsvImportPreview {
  preview: CsvImportRow[];
  errors: CsvImportError[];
  wouldImport: number;
  wouldSkip: number;
}

export const REQUIRED_HEADERS = ['client_id', 'name', 'monitor_type'] as const;
export const OPTIONAL_HEADERS = ['ping_host'] as const;
export const ALL_HEADERS = [...REQUIRED_HEADERS, ...OPTIONAL_HEADERS] as const;

export const CSV_MAX_FILE_BYTES = 1024 * 1024;
export const CSV_IMPORT_TTL_MS = 10 * 60 * 1000;