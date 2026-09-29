import { describe, it, expect, vi } from 'vitest';
import { HttpsPrtgTransport } from '@/integrations/prtg/prtg.transport';
import { FakeHttps } from '../../../helpers/fake-https';
import type { PrtgClientConfig } from '@/config/env';

const CONFIG: PrtgClientConfig = {
  baseUrl: 'https://prtg.example.com',
  username: 'user',
  passhash: 'passhash123',
  rejectUnauthorized: true,
};

function transport(httpsModule: any) {
  return new HttpsPrtgTransport(CONFIG, httpsModule);
}

function sensorEnvelope(rows: unknown[], total?: number) {
  const env: Record<string, unknown> = { sensors: rows };
  if (total !== undefined) {
    env.treesize = total;
  }
  return env;
}

describe('R6: Transport pagination and completeness', () => {
  describe('envelope wire format', () => {
    it('extracts array from PRTG object envelope', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([{ objid: 1, device: 'D', sensor: 'S', type: 'Ping' }], 1)) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([{ objid: 1, device: 'D', sensor: 'S', type: 'Ping' }], 1));
      const result = await p;

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].objid).toBe(1);
      expect(result.total).toBe(1);
    });

    it('rejects envelope missing expected table key', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200 }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject({ other: 'stuff' });

      await expect(p).rejects.toThrow('did not contain expected sensors array');
    });

    it('rejects wrong table key in envelope', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200 }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('devices', 0, 500);
      fakeHttps.requests[0].res.flushObject({ sensors: [{ objid: 1 }] });

      await expect(p).rejects.toThrow('did not contain expected devices array');
    });

    it('accepts empty array in envelope', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([])) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([]));

      const result = await p;
      expect(result.rows).toHaveLength(0);
    });
  });

  describe('redirect rejection', () => {
    it('rejects 3xx redirect to different origin', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 302, headers: { location: 'https://evil.com/path' } }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flush('');
      await expect(p).rejects.toMatchObject({ code: 'EXTERNAL_ERROR', metadata: expect.objectContaining({ redirect: true }) });
    });
  });

  describe('timeout and bounds', () => {
    it('rejects after request timeout', async () => {
      vi.useFakeTimers();
      const fakeHttps = new FakeHttps([{ statusCode: 200 }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);

      vi.advanceTimersByTime(21000);

      await expect(p).rejects.toThrow('timed out');
      vi.useRealTimers();
    });

    it('rejects response exceeding 10 MiB', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200 }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      const big = 'x'.repeat(11 * 1024 * 1024);
      fakeHttps.requests[0].res.emitData(big);
      await expect(p).rejects.toThrow('exceeded maximum allowed size');
    });
  });

  describe('pagination with start/count/sortby', () => {
    it('sets start, count, and sortby=objid parameters', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([])) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 5000, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([]));
      await p;

      const opts = fakeHttps.requests[0].options;
      expect(opts.path).toContain('start=5000');
      expect(opts.path).toContain('count=500');
      expect(opts.path).toContain('sortby=objid');
    });
  });
});
