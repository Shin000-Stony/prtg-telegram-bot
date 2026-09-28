import { customerService } from '../customers/customer.service';
import { parseCsv, generatePreview } from './csv-import.parser';
import type { CsvImportResult, CsvImportPreview, ValidatedCsvRow } from './csv-import.types';
import { AppError } from '../../core/errors/app-error';
import { getLogger } from '../../core/logger';

const logger = getLogger().child({ module: 'CsvImportService' });

export interface ImportOptions {
  dryRun?: boolean;
  skipDuplicates?: boolean;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: Array<{ rowNumber: number; message: string }>;
}

export interface ImportSummary {
  totalRows: number;
  validCount: number;
  errorCount: number;
  newCount: number;
  duplicateInCsv: number;
  existingInDb: number;
}

export class CsvImportService {
  parse(content: string): CsvImportResult {
    return parseCsv(content);
  }

  preview(content: string, limit = 10): CsvImportPreview {
    const result = parseCsv(content);

    const seenClientIds = new Set<string>();

    for (const row of result.valid) {
      if (seenClientIds.has(row.clientId)) {
        continue;
      }
      seenClientIds.add(row.clientId);

      const existing = customerService.getByClientId(row.clientId);
      if (existing) {
        continue;
      }
    }

    const validToImport = result.valid.filter((row, index, arr) => 
      arr.findIndex(r => r.clientId === row.clientId) === index
    );

    let wouldImportCount = 0;
    for (const row of validToImport) {
      const existing = customerService.getByClientId(row.clientId);
      if (!existing) {
        wouldImportCount++;
      }
    }

    const wouldSkip = result.totalRows - wouldImportCount;

    return {
      preview: generatePreview({ ...result, valid: validToImport }, limit),
      errors: result.errors.slice(0, 10),
      wouldImport: wouldImportCount,
      wouldSkip,
    };
  }

  validateAndSummarize(content: string): { result: CsvImportResult; summary: ImportSummary; rowsToImport: ValidatedCsvRow[] } {
    const result = parseCsv(content);

    const rowsToImport: ValidatedCsvRow[] = [];

    for (const row of result.valid) {
      const existing = customerService.getByClientId(row.clientId);
      if (existing) {
        continue;
      }

      rowsToImport.push(row);
    }

    const summary: ImportSummary = {
      totalRows: result.totalRows,
      validCount: result.validCount,
      errorCount: result.errorCount,
      newCount: rowsToImport.length,
      duplicateInCsv: result.duplicateCount,
      existingInDb: result.valid.length - rowsToImport.length,
    };

    return { result, summary, rowsToImport };
  }

  async import(rows: ValidatedCsvRow[]): Promise<ImportResult> {
    if (rows.length === 0) {
      return { imported: 0, skipped: 0, errors: [] };
    }

    const createInputs = rows.map((r) => ({
      clientId: r.clientId,
      name: r.name,
      monitorType: r.monitorType,
      pingHost: r.pingHost,
      enabled: true,
    }));

    try {
      customerService.bulkCreate(createInputs);
      logger.info({ imported: rows.length }, 'Import completed');
      return { imported: rows.length, skipped: 0, errors: [] };
    } catch (error) {
      logger.error({ err: error }, 'Bulk import failed');
      throw AppError.database('Failed to import customers', { originalError: String(error) });
    }
  }
}

export const csvImportService = new CsvImportService();