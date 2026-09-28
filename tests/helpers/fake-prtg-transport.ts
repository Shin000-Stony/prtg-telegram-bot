import type { PrtgTable, PrtgTransport, PrtgPageResult } from '@/integrations/prtg/prtg.types';

export class FakePrtgTransport implements PrtgTransport {
  public calls: Array<{ table: PrtgTable; start: number; count: number }> = [];
  public throwOnCall: ((call: { table: PrtgTable; start: number; count: number }) => Error | undefined) | undefined;
  public pages: Map<string, { responses: unknown[][], totals: (number | null)[] }>;

  constructor() {
    this.pages = new Map();
  }

  addPage(table: PrtgTable, rows: unknown[], total: number | null = null): void {
    const existing = this.pages.get(table) ?? { responses: [], totals: [] };
    existing.responses.push(rows);
    existing.totals.push(total);
    this.pages.set(table, existing);
  }

  async fetchPage(table: PrtgTable, start: number, count: number): Promise<PrtgPageResult> {
    const call = { table, start, count };
    this.calls.push(call);
    if (this.throwOnCall) {
      const err = this.throwOnCall(call);
      if (err) {
        throw err;
      }
    }
    const entry = this.pages.get(table);
    const pageIndex = Math.floor(start / 500);
    if (!entry || pageIndex >= entry.responses.length) {
      return { rows: [], total: null };
    }
    return {
      rows: entry.responses[pageIndex],
      total: entry.totals[pageIndex],
    };
  }
}
