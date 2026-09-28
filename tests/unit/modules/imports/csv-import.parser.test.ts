import { describe, it, expect } from 'vitest';
import { parseCsv, generatePreview } from '@/modules/imports/csv-import.parser';
import { CsvImportResult } from '@/modules/imports/csv-import.types';

describe('CSV Import Parser', () => {
  const validCsv = `client_id,name,monitor_type,ping_host
11,HENGJAYA,prtg,
21,CITRA CELEBAS,icmp,10.10.10.21
22,SANATEL,icmp,10.10.10.22`;

  it('parses valid CSV', () => {
    const result = parseCsv(validCsv);

    expect(result.validCount).toBe(3);
    expect(result.errorCount).toBe(0);
    expect(result.totalRows).toBe(3);
    expect(result.valid[0]).toEqual({
      clientId: '11',
      name: 'HENGJAYA',
      monitorType: 'prtg',
      pingHost: null,
      rowNumber: 1,
    });
    expect(result.valid[1]).toEqual({
      clientId: '21',
      name: 'CITRA CELEBAS',
      monitorType: 'icmp',
      pingHost: '10.10.10.21',
      rowNumber: 2,
    });
    expect(result.valid[2]).toEqual({
      clientId: '22',
      name: 'SANATEL',
      monitorType: 'icmp',
      pingHost: '10.10.10.22',
      rowNumber: 3,
    });
  });

  it('handles quoted customer name containing comma', () => {
    const csv = `client_id,name,monitor_type,ping_host
11,"HENG, JAYA",prtg,`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(1);
    expect(result.valid[0].name).toBe('HENG, JAYA');
  });

  it('trims surrounding whitespace', () => {
    const csv = `client_id,name,monitor_type,ping_host
 11 ,  HENGJAYA  ,  prtg  ,  `;

    const result = parseCsv(csv);

    expect(result.valid[0].clientId).toBe('11');
    expect(result.valid[0].name).toBe('HENGJAYA');
    expect(result.valid[0].monitorType).toBe('prtg');
  });

  it('rejects missing required header', () => {
    const csv = `client_id,name
11,HENGJAYA`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].field).toBe('_headers');
    expect(result.errors[0].message).toContain('monitor_type');
  });

  it('rejects empty client_id', () => {
    const csv = `client_id,name,monitor_type,ping_host
,HENGJAYA,prtg,`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].field).toBe('client_id');
    expect(result.errors[0].message).toContain('required');
  });

  it('rejects empty name', () => {
    const csv = `client_id,name,monitor_type,ping_host
11,,prtg,`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].field).toBe('name');
  });

  it('rejects unsupported monitor type', () => {
    const csv = `client_id,name,monitor_type,ping_host
11,HENGJAYA,invalid,`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].field).toBe('monitor_type');
    expect(result.errors[0].message).toContain('Invalid monitor type');
  });

  it('detects duplicate client_id within same CSV', () => {
    const csv = `client_id,name,monitor_type,ping_host
11,HENGJAYA,prtg,
11,HENGJAYA2,icmp,10.10.10.11`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].field).toBe('client_id');
    expect(result.errors[0].message).toContain('Duplicate');
  });

  it('validates IP/hostname for ICMP monitor type', () => {
    const csv = `client_id,name,monitor_type,ping_host
21,TEST,icmp,invalid-host`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].field).toBe('ping_host');
  });

  it('accepts valid IPv4 for ICMP', () => {
    const csv = `client_id,name,monitor_type,ping_host
21,TEST,icmp,192.168.1.1`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(1);
    expect(result.valid[0].pingHost).toBe('192.168.1.1');
  });

  it('accepts valid hostname for ICMP', () => {
    const csv = `client_id,name,monitor_type,ping_host
21,TEST,icmp,server.example.com`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(1);
    expect(result.valid[0].pingHost).toBe('server.example.com');
  });

  it('allows empty ping_host for PRTG', () => {
    const csv = `client_id,name,monitor_type,ping_host
11,HENGJAYA,prtg,`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(1);
    expect(result.valid[0].pingHost).toBeNull();
  });

  it('returns row numbers in errors', () => {
    const csv = `client_id,name,monitor_type,ping_host
11,HENGJAYA,prtg,
,INVALID,icmp,10.10.10.1
22,SANATEL,invalid,`;

    const result = parseCsv(csv);

    expect(result.errors[0].rowNumber).toBe(2);
    expect(result.errors[1].rowNumber).toBe(3);
  });

  it('handles empty CSV', () => {
    const result = parseCsv('');

    expect(result.totalRows).toBe(0);
    expect(result.validCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].message).toContain('empty');
  });

  it('handles CSV with only headers', () => {
    const csv = `client_id,name,monitor_type,ping_host
`;

    const result = parseCsv(csv);

    // csv-parse returns 0 records for headers-only CSV
    expect(result.totalRows).toBe(0);
    expect(result.validCount).toBe(0);
    expect(result.errorCount).toBe(1); // empty client_id error for the empty row
  });

  it('generates preview', () => {
    const result = parseCsv(validCsv);
    const preview = generatePreview(result, 2);

    expect(preview.length).toBe(2);
    expect(preview[0].clientId).toBe('11');
    expect(preview[1].clientId).toBe('21');
  });

  it('handles UTF-8 content', () => {
    const csv = `client_id,name,monitor_type,ping_host
11,हिन्दी नाम,prtg,`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(1);
    expect(result.valid[0].name).toBe('हिन्दी नाम');
  });

  it('handles case-insensitive monitor types', () => {
    const csv = `client_id,name,monitor_type,ping_host
11,TEST,PRTG,
21,TEST2,Icmp,10.0.0.1
31,TEST3,Pic,`;

    const result = parseCsv(csv);

    expect(result.validCount).toBe(3);
    expect(result.valid[0].monitorType).toBe('prtg');
    expect(result.valid[1].monitorType).toBe('icmp');
    expect(result.valid[2].monitorType).toBe('pic');
  });
});