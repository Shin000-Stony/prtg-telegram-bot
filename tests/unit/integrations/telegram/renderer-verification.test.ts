import { describe, it, expect, vi } from 'vitest';
import { formatStatusCard, formatStatusBrief, formatSummaryCard, formatDownList } from '@/integrations/telegram/commands/status.command';
import { buildAlertCard, buildDownCard, buildRecoveryCard } from '@/integrations/telegram/ui/alert-card';
import { formatCsvPreview } from '@/integrations/telegram/ui/messages';

vi.stubEnv('TZ', 'Asia/Makassar');

describe('Renderer verification', () => {
  it('NOT_CHECKED with no observation shows Last checked: —', () => {
    const card = formatStatusCard({
      customer: { id: 1, clientId: 'CLI-1', name: 'Test Customer', monitorType: 'prtg', pingHost: null },
      status: 'NOT_CHECKED',
      dataQuality: 'unavailable',
      fetchedAt: new Date('2026-09-28T04:25:00Z').toISOString(),
      mapping: null,
      lastKnownStatus: null,
      reason: null,
      autoUnverified: false,
    });
    expect(card).toContain('⏳ NOT CHECKED');
    expect(card).toContain('Last checked : —');
    expect(card).not.toContain('Fetched at');
  });

  it('DISABLED customer has no Fetched at', () => {
    const card = formatStatusCard({
      customer: { id: 2, clientId: 'CLI-2', name: 'Disabled Customer', monitorType: 'prtg', pingHost: null },
      status: 'DISABLED',
      dataQuality: 'not_applicable',
      fetchedAt: new Date('2026-09-28T04:25:00Z').toISOString(),
      mapping: null,
      lastKnownStatus: null,
      reason: null,
      autoUnverified: false,
    });
    expect(card).toContain('⚫ DISABLED');
    expect(card).not.toContain('Fetched at');
    expect(card).not.toContain('Last checked');
  });

  it('UP customer shows Fetched at with WITA', () => {
    const card = formatStatusCard({
      customer: { id: 1, clientId: 'CLI-UP', name: 'UP Customer', monitorType: 'prtg', pingHost: null },
      status: 'UP',
      dataQuality: 'fresh',
      fetchedAt: new Date('2026-09-28T04:25:00Z').toISOString(),
      mapping: { prtgDeviceName: 'Server1', prtgSensorName: 'Ping', prtgObjectId: 1001, verified: true },
      lastKnownStatus: null,
      reason: null,
      autoUnverified: false,
    });
    expect(card).toContain('🟢 UP');
    expect(card).toContain('Fetched at : 28 Sep 2026, 12.25 WITA');
  });

  it('DOWN list with 0 confirmed and uncertainCount > 0 shows correct message', () => {
    const lines = formatDownList({
      items: [],
      total: 0,
      page: 1,
      totalPages: 1,
      fetchedAt: new Date('2026-09-28T04:25:00Z').toISOString(),
      dataQuality: 'fresh',
      uncertainCount: 3,
      pageOutOfRange: false,
    });
    const output = lines.join('\n');
    expect(output).toContain('Page 1/1 (0 total)');
    expect(output).toContain('Status unavailable or uncertain for 3 customer(s).');
    expect(output).toContain('No confirmed DOWN customers on fresh data.');
  });

  it('Summary card shows bucket counts', () => {
    const card = formatSummaryCard({
      total: 5,
      buckets: [
        { status: 'UP', count: 3 },
        { status: 'DOWN', count: 1 },
        { status: 'NOT_CHECKED', count: 1 },
      ],
      dataQuality: { fresh: 4, stale: 1, unavailable: 1, not_applicable: 0 },
      fetchedAt: new Date('2026-09-28T04:25:00Z').toISOString(),
    });
    expect(card).toContain('SUMMARY');
    expect(card).toContain('Total Customers: 5');
    expect(card).toContain('need attention');
  });

  it('Alert DOWN card format', () => {
    const card = buildDownCard({
      client_id: 'CLI-DOWN',
      customer_name: 'Server Down',
      monitor_source: 'PRTG',
      target_display: 'Device1 Sensor1',
      occurrence_at: new Date('2026-09-28T04:25:00Z').getTime(),
      event_key: 'evt_down_1234567890',
      monitor_type: 'prtg',
      prtg_object_id: 1001,
    });
    expect(card.valid).toBe(true);
    expect(card.html).toContain('🔴 DOWN');
    expect(card.html).toContain('Client:</b> CLI-DOWN');
    expect(card.html).toContain('Customer:</b> Server Down');
    expect(card.html).toContain('Source:</b> PRTG');
    expect(card.html).toContain('Target:</b> Device1 Sensor1');
    expect(card.html).toContain('Transition:</b> Sep 28, 2026, 12:25:00 PM WITA');
    expect(card.html).toContain('Ref:</b> evt_down');
  });

  it('Alert RECOVERY card format', () => {
    const card = buildRecoveryCard({
      client_id: 'CLI-UP',
      customer_name: 'Server Up',
      monitor_source: 'PRTG',
      target_display: 'Device1 Sensor1',
      occurrence_at: new Date('2026-09-28T05:30:00Z').getTime(),
      event_key: 'evt_rec_0987654321',
      monitor_type: 'prtg',
      prtg_object_id: 1001,
    });
    expect(card.valid).toBe(true);
    expect(card.html).toContain('🟢 RECOVERY');
  });

  it('CSV preview format', () => {
    const preview = formatCsvPreview('import.csv', {
      totalRows: 1,
      validCount: 1,
      errorCount: 0,
      newCount: 1,
      duplicateInCsv: 0,
      existingInDb: 0,
    }, [], [{ clientId: 'CLI-1', name: 'Test', monitorType: 'prtg' }]);
    expect(preview).toContain('📥 <b>CSV IMPORT PREVIEW</b>');
    expect(preview).toContain('File       : import.csv');
    expect(preview).toContain('Rows       : 1');
    expect(preview).toContain('#CLI-1 Test — PRTG');
  });

  it('Status brief for NOT_CHECKED hides timestamp', () => {
    const brief = formatStatusBrief({
      customer: { id: 1, clientId: 'CLI-1', name: 'Test', monitorType: 'prtg', pingHost: null },
      status: 'NOT_CHECKED',
      dataQuality: 'unavailable',
      fetchedAt: new Date('2026-09-28T04:25:00Z').toISOString(),
      mapping: null,
      lastKnownStatus: null,
      reason: null,
      autoUnverified: false,
    });
    expect(brief).toContain('⏳ NOT CHECKED');
    expect(brief).not.toContain('WITA');
  });
});
