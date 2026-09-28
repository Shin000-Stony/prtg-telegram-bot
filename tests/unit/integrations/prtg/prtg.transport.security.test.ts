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

describe('R2: Transport security and error handling', () => {
  describe('secret sanitization in error logging', () => {
    it('does not leak secrets in JSON parse error message', async () => {
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

    it('does not include passhash or URL in error metadata', async () => {
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
      expect(metadata).not.toHaveProperty('url');
      expect(metadata).not.toHaveProperty('passhash');
      expect(metadata).not.toHaveProperty('username');
      expect(JSON.stringify(metadata)).not.toContain('passhash123');
    });
  });

  describe('status field handling', () => {
    it('accepts display status string alongside raw numeric status', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify({ sensors: [{ objid: 1, device: 'D', sensor: 'S', type: 'Ping', status_raw: 3, status: 'Up' }] }) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject({ sensors: [{ objid: 1, device: 'D', sensor: 'S', type: 'Ping', status_raw: 3, status: 'Up' }] });
      const result = await p;

      expect(result.rows[0].status_raw).toBe(3);
      expect(result.rows[0].status).toBe('Up');
    });

    it('handles null/undefined status without failing', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify({ sensors: [{ objid: 1, device: 'D', sensor: 'S', type: 'Ping', status_raw: null, status: null }] }) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject({ sensors: [{ objid: 1, device: 'D', sensor: 'S', type: 'Ping', status_raw: null, status: null }] });
      const result = await p;

      expect(result.rows[0].status_raw).toBeNull();
      expect(result.rows[0].status).toBeNull();
    });
  });

  describe('positive safe integer validation', () => {
    it('rejects boolean values as object ID', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify({ sensors: [{ objid: true, device: 'D', sensor: 'S', type: 'Ping' }] }) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject({ sensors: [{ objid: true, device: 'D', sensor: 'S', type: 'Ping' }] });
      await expect(p).rejects.toThrow('malformed');
    });

    it('rejects partial numeric strings like "5junk"', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify({ sensors: [{ objid: '5junk', device: 'D', sensor: 'S', type: 'Ping' }] }) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject({ sensors: [{ objid: '5junk', device: 'D', sensor: 'S', type: 'Ping' }] });
      await expect(p).rejects.toThrow('malformed');
    });

    it('rejects zero and negative values', async () => {
      const fakeHttps = new FakeHttps([{ statusCode: 200, body: JSON.stringify({ sensors: [{ objid: 0, device: 'D', sensor: 'S', type: 'Ping' }] }) }]);
      const tr = transport(fakeHttps);

      const p = tr.fetchPage('sensors', 0, 500);
      fakeHttps.requests[0].res.flushObject({ sensors: [{ objid: 0, device: 'D', sensor: 'S', type: 'Ping' }] });
      await expect(p).rejects.toThrow('malformed');
    });
  });
});
