import { describe, it, expect, vi } from 'vitest';
import { HttpsPrtgTransport } from '@/integrations/prtg/prtg.transport';
import { FakeHttps } from '../../../helpers/fake-https';
import { AppError } from '@/core/errors/app-error';
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

function deviceEnvelope(rows: unknown[], total?: number) {
  const env: Record<string, unknown> = { devices: rows };
  if (total !== undefined) {
    env.treesize = total;
  }
  return env;
}

describe('HttpsPrtgTransport', () => {
  describe('successful response', () => {
    it('parses array response for sensors', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([{ objid: 1, device: 'Dev', sensor: 'Ping', type: 'Ping' }])) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([{ objid: 1, device: 'Dev', sensor: 'Ping', type: 'Ping' }]));
      const result = await p;

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].objid).toBe(1);
      expect(result.total).toBeNull();
    });

    it('extracts treesize from envelope as total', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([{ objid: 1, device: 'Dev', sensor: 'Ping', type: 'Ping' }], 5306)) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([{ objid: 1, device: 'Dev', sensor: 'Ping', type: 'Ping' }], 5306));
      const result = await p;

      expect(result.total).toBe(5306);
    });

    it('returns null total when treesize absent', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([{ objid: 1, device: 'Dev', sensor: 'Ping', type: 'Ping' }])) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([{ objid: 1, device: 'Dev', sensor: 'Ping', type: 'Ping' }]));
      const result = await p;

      expect(result.total).toBeNull();
    });

    it('builds URL with credentials, columns, pagination', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([])) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 1000, 250);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([]));
      await p;

      const opts = fakeHttps.requests[0].options;
      expect(opts.hostname).toBe('prtg.example.com');
      expect(opts.path).toContain('content=sensors');
      expect(opts.path).toContain('columns=objid%2Cdevice%2Csensor%2Ctype%2Cstatus_raw%2Cstatus%2Cstatusmessage%2Clastvalue%2Clastup%2Clastdown%2Chost');
      expect(opts.path).toContain('start=1000');
      expect(opts.path).toContain('count=250');
      expect(opts.path).toContain('username=user');
      expect(opts.path).toContain('passhash=passhash123');
      expect(opts.path).toContain('output=json');
      expect(opts.path).toContain('sortby=objid');
    });
  });

  describe('redirect rejection', () => {
    it('rejects 3xx with redirect flag and no data', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 301, headers: { location: 'https://evil.com' } }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flush('');
      await expect(p).rejects.toThrow('PRTG API request failed');
      await expect(p).rejects.toMatchObject({ code: 'EXTERNAL_ERROR', metadata: expect.objectContaining({ redirect: true, httpStatus: 301 }) });
      expect(fakeHttps.requests[0].res.resumed).toBe(true);
    });
  });

  describe('unauthorized / non-OK', () => {
    it('rejects 401 with metadata', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 401 }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flush('');
      await expect(p).rejects.toThrow('PRTG API request failed');
      await expect(p).rejects.toMatchObject({ code: 'EXTERNAL_ERROR', metadata: expect.objectContaining({ httpStatus: 401, redirect: false }) });
    });

    it('rejects 500 with metadata', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 500 }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flush('');
      await expect(p).rejects.toMatchObject({ code: 'EXTERNAL_ERROR', metadata: expect.objectContaining({ httpStatus: 500 }) });
    });
  });

  describe('malformed body', () => {
    it('rejects non-JSON response', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: 'not json' }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flush('not json');
      await expect(p).rejects.toThrow('unparseable');
    });

    it('accepts JSON array with known fields', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([{ objid: 1, device: 'D', sensor: 'S', type: 'Ping' }])) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([{ objid: 1, device: 'D', sensor: 'S', type: 'Ping' }]));
      const result = await p;

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].objid).toBe(1);
    });

    it('rejects JSON null response', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: 'null' }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flush('null');
      await expect(p).rejects.toThrow('non-object response');
    });
  });

  describe('body size limit', () => {
    it('rejects response exceeding 10 MiB', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200 }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      const big = 'x'.repeat(11 * 1024 * 1024);
      fakeHttps.requests[0].res.emitData(big);
      await expect(p).rejects.toThrow('exceeded maximum allowed size');
    });
  });

  describe('TLS isolation', () => {
    it('sets rejectUnauthorized=undefined when config true (secure default)', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([])) }]);
      const tr = new HttpsPrtgTransport({ ...CONFIG, rejectUnauthorized: true }, fakeHttps as any);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([]));
      await p;

      expect(fakeHttps.requests[0].options.rejectUnauthorized).toBeUndefined();
    });

    it('sets rejectUnauthorized=false when config false (self-signed)', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([])) }]);
      const tr = new HttpsPrtgTransport({ ...CONFIG, rejectUnauthorized: false }, fakeHttps as any);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([]));
      await p;

      expect(fakeHttps.requests[0].options.rejectUnauthorized).toBe(false);
    });
  });

  describe('secret sanitization', () => {
    it('does not leak passhash or full URL in error metadata', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 500 }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flush('');
      let error: any;
      try {
        await p;
      } catch (e) {
        error = e;
      }

      const metadata = error?.metadata;
      expect(metadata).toBeDefined();
      expect(metadata).not.toHaveProperty('url');
      expect(metadata).not.toHaveProperty('passhash');
      expect(metadata).not.toHaveProperty('username');
      expect(JSON.stringify(metadata)).not.toContain('passhash123');
      expect(JSON.stringify(metadata)).not.toContain('user');
    });

    it('does not leak secrets in malformed JSON error logs', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: 'SECRET42 invalid json' }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flush('SECRET42 invalid json');
      let error: any;
      try {
        await p;
      } catch (e) {
        error = e;
      }
      expect(error?.message).not.toContain('SECRET42');
      expect(error?.message).not.toContain('invalid json');
    });
  });

  describe('timeout', () => {
    it('rejects after timeout when no response', async () => {
      vi.useFakeTimers();
      const fakeHttps = new FakeHttps([{ statusCode: 200 }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);

      vi.advanceTimersByTime(11000);

      await expect(p).rejects.toThrow('timed out');
      vi.useRealTimers();
    });
  });

  describe('devices table', () => {
    it('fetches devices with correct columns', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(deviceEnvelope([])) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('devices', 0, 500);
      fakeHttps.requests[0].res.flushObject(deviceEnvelope([]));
      await p;

      const opts = fakeHttps.requests[0].options;
      expect(opts.path).toContain('content=devices');
      expect(opts.path).toContain('columns=objid%2Cdevice%2Chost%2Cstatus_raw%2Cstatus%2Cname');
    });
  });

  describe('pagination', () => {
    it('returns empty rows with null total when page is empty', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([])) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([]));
      const result = await p;

      expect(result.rows).toEqual([]);
      expect(result.total).toBeNull();
    });

    it('validates positive safe integer objid', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([{ objid: true, device: 'D', sensor: 'S', type: 'Ping' }])) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([{ objid: true, device: 'D', sensor: 'S', type: 'Ping' }]));
      await expect(p).rejects.toThrow('malformed');
    });

    it('accepts display status string and raw numeric status', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify(sensorEnvelope([{ objid: 1, device: 'D', sensor: 'S', type: 'Ping', status_raw: 3, status: 'Up' }])) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject(sensorEnvelope([{ objid: 1, device: 'D', sensor: 'S', type: 'Ping', status_raw: 3, status: 'Up' }]));
      const result = await p;

      expect(result.rows[0].status_raw).toBe(3);
      expect(result.rows[0].status).toBe('Up');
    });
  });
});
