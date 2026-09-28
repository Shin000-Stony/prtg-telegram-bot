import { parse } from 'csv-parse/sync';
import type { MonitorType} from '../../config/constants';
import { MONITOR_TYPES } from '../../config/constants';
import type { CsvImportRow, CsvImportResult, CsvImportError} from './csv-import.types';
import { REQUIRED_HEADERS } from './csv-import.types';
import { AppError } from '../../core/errors/app-error';
import { getLogger } from '../../core/logger';

const logger = getLogger().child({ module: 'CsvImportParser' });

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, '_');
}

function validateMonitorType(value: string, rowNumber: number): { valid: boolean; type?: MonitorType; error?: CsvImportError } {
  const normalized = value.trim().toLowerCase();
  if (MONITOR_TYPES.includes(normalized as MonitorType)) {
    return { valid: true, type: normalized as MonitorType };
  }
  return {
    valid: false,
    error: {
      rowNumber,
      field: 'monitor_type',
      message: `Invalid monitor type: ${value}. Allowed: ${MONITOR_TYPES.join(', ')}`,
      value,
    },
  };
}

function validateRequiredField(value: string, fieldName: string, rowNumber: number): CsvImportError | null {
  if (!value || value.trim() === '') {
    return {
      rowNumber,
      field: fieldName,
      message: `${fieldName} is required`,
      value,
    };
  }
  return null;
}

function validatePingHost(value: string | null, monitorType: MonitorType, rowNumber: number): CsvImportError | null {
  const trimmed = value?.trim() ?? '';
  if (monitorType === 'icmp') {
    if (!trimmed) {
      return {
        rowNumber,
        field: 'ping_host',
        message: 'ping_host is required for ICMP monitor type',
        value: '',
      };
    }
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const hostnameRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!ipv4Regex.test(trimmed) && !hostnameRegex.test(trimmed)) {
      return {
        rowNumber,
        field: 'ping_host',
        message: `Invalid IP address or hostname for ICMP monitoring: ${trimmed}`,
        value: trimmed,
      };
    }
  }
  return null;
}

export function parseCsv(content: string): CsvImportResult {
  logger.debug({ contentLength: content.length }, 'Parsing CSV content');

  let records: Record<string, string>[];
  try {
    records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      relax_column_count: true,
    });
  } catch (error) {
    logger.error({ err: error }, 'CSV parse failed');
    throw AppError.validation('Invalid CSV format', { originalError: String(error) });
  }

  if (records.length === 0) {
    return {
      valid: [],
      errors: [{ rowNumber: 0, field: '_file', message: 'CSV file is empty', value: '' }],
      totalRows: 0,
      validCount: 0,
      errorCount: 1,
      duplicateCount: 0,
    };
  }

  const headers = Object.keys(records[0] || {}).map(normalizeHeader);
  const missingHeaders = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missingHeaders.length > 0) {
    return {
      valid: [],
      errors: [{
        rowNumber: 0,
        field: '_headers',
        message: `Missing required headers: ${missingHeaders.join(', ')}`,
        value: headers.join(', '),
      }],
      totalRows: records.length,
      validCount: 0,
      errorCount: 1,
      duplicateCount: 0,
    };
  }

  const valid: CsvImportRow[] = [];
  const errors: CsvImportError[] = [];
  const seenClientIds = new Set<string>();
  let duplicateCount = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const rowNumber = i + 1;
    const normalizedRecord: Record<string, string> = {};

    for (const [key, value] of Object.entries(record)) {
      normalizedRecord[normalizeHeader(key)] = value?.trim() ?? '';
    }

    const clientId = normalizedRecord.client_id ?? '';
    const name = normalizedRecord.name ?? '';
    const monitorTypeRaw = normalizedRecord.monitor_type ?? '';
    const pingHost = normalizedRecord.ping_host ?? null;

    const clientIdError = validateRequiredField(clientId, 'client_id', rowNumber);
    if (clientIdError) {
      errors.push(clientIdError);
      continue;
    }

    if (seenClientIds.has(clientId)) {
      errors.push({
        rowNumber,
        field: 'client_id',
        message: `Duplicate client_id in CSV: ${clientId}`,
        value: clientId,
      });
      duplicateCount++;
      continue;
    }
    seenClientIds.add(clientId);

    const nameError = validateRequiredField(name, 'name', rowNumber);
    if (nameError) {
      errors.push(nameError);
      continue;
    }

    const monitorTypeValidation = validateMonitorType(monitorTypeRaw, rowNumber);
    if (!monitorTypeValidation.valid || !monitorTypeValidation.type) {
      errors.push(monitorTypeValidation.error!);
      continue;
    }

    const pingHostError = validatePingHost(pingHost, monitorTypeValidation.type, rowNumber);
    if (pingHostError) {
      errors.push(pingHostError);
      continue;
    }

    valid.push({
      clientId,
      name,
      monitorType: monitorTypeValidation.type,
      pingHost: pingHost?.trim() || null,
      rowNumber,
    });
  }

  logger.info({ validCount: valid.length, errorCount: errors.length, totalRows: records.length }, 'CSV parse completed');

  return {
    valid,
    errors,
    totalRows: records.length,
    validCount: valid.length,
    errorCount: errors.length,
    duplicateCount,
  };
}

export function generatePreview(result: CsvImportResult, limit = 10): CsvImportRow[] {
  return result.valid.slice(0, limit);
}