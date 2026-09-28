import { describe, it, expect } from 'vitest';
import { PrtgClient, PRTG_PAGE_SIZE } from '@/integrations/prtg/prtg.client';
import { FakePrtgTransport } from '../../../helpers/fake-prtg-transport';

function sensorRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objid: 1000,
    device: 'Device-1000',
    sensor: 'Ping',
    type: 'Ping',
    status_raw: 3,
    status: 'Up',
    statusmessage: 'Up',
    lastvalue: '0%',
    lastup: '2026-01-01 00:00:00',
    lastdown: '',
    host: '10.0.0.1',
    ...over,
  };
}

function deviceRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objid: 5000,
    device: 'Device-5000',
    host: '10.0.0.1',
    status_raw: 3,
    status: 'Up',
    name: 'Device-5000',
    ...over,
  };
}

function client(transport: FakePrtgTransport) {
  return new PrtgClient({
    config: { baseUrl: 'https://prtg.example.com', username: 'u', passhash: 'ph', rejectUnauthorized: true },
    transport,
  });
}

describe('PrtgClient', () => {
  describe('fetchInventory (sensors)', () => {
    it('normalizes a single sensor row', async () => {
      const transport = new FakePrtgTransport();
      transport.addPage('sensors', [sensorRow({ objid: 4036, device: 'Dev-4036', sensor: 'Ping', type: 'Ping' })], 1);
      transport.addPage('devices', [], 0);

      const { sensors } = await client(transport).fetchInventory();

      expect(sensors).toHaveLength(1);
      expect(sensors[0]).toEqual({
        objectId: 4036,
        deviceName: 'Dev-4036',
        sensorName: 'Ping',
        sensorType: 'Ping',
        statusRaw: 3,
        statusDisplay: 'Up',
        statusMessage: 'Up',
        lastValue: '0%',
        lastUp: '2026-01-01 00:00:00',
        lastDown: null,
      });
    });

    it('coerces status provided as string to number', async () => {
      const transport = new FakePrtgTransport();
      transport.addPage('sensors', [sensorRow({ status_raw: '3', status: 'Up' })], 1);
      transport.addPage('devices', [], 0);
      const { sensors } = await client(transport).fetchInventory();
      expect(sensors[0].statusRaw).toBe(3);
    });

    it('maps null status fields to null', async () => {
      const transport = new FakePrtgTransport();
      transport.addPage('sensors', [sensorRow({ status_raw: null, status: null, statusmessage: '', lastvalue: '', lastup: '', lastdown: null })], 1);
      transport.addPage('devices', [], 0);
      const { sensors } = await client(transport).fetchInventory();
      expect(sensors[0].statusRaw).toBeNull();
      expect(sensors[0].statusDisplay).toBeNull();
      expect(sensors[0].statusMessage).toBeNull();
      expect(sensors[0].lastValue).toBeNull();
      expect(sensors[0].lastUp).toBeNull();
      expect(sensors[0].lastDown).toBeNull();
    });
  });

  describe('pagination', () => {
    it('pages through multiple pages until total is reached', async () => {
      const transport = new FakePrtgTransport();
      const fullPage = Array.from({ length: PRTG_PAGE_SIZE }, (_, i) => sensorRow({ objid: 1000 + i }));
      const shortPage = [sensorRow({ objid: 9999 })];
      transport.addPage('sensors', fullPage, PRTG_PAGE_SIZE + 1);
      transport.addPage('sensors', shortPage, PRTG_PAGE_SIZE + 1);
      transport.addPage('devices', [], 0);

      const { sensors } = await client(transport).fetchInventory();

      expect(sensors).toHaveLength(PRTG_PAGE_SIZE + 1);
      expect(transport.calls.filter((c) => c.table === 'sensors')).toHaveLength(2);
      expect(transport.calls[0]).toEqual({ table: 'sensors', start: 0, count: PRTG_PAGE_SIZE });
      expect(transport.calls[1]).toEqual({ table: 'sensors', start: PRTG_PAGE_SIZE, count: 1 });
    });

    it('stops cleanly when a page is an exact multiple of page size with total', async () => {
      const transport = new FakePrtgTransport();
      const fullPage = Array.from({ length: PRTG_PAGE_SIZE }, (_, i) => sensorRow({ objid: 2000 + i }));
      transport.addPage('sensors', fullPage, PRTG_PAGE_SIZE);
      transport.addPage('devices', [], 0);

      const { sensors } = await client(transport).fetchInventory();

      expect(sensors).toHaveLength(PRTG_PAGE_SIZE);
      expect(transport.calls.filter((c) => c.table === 'sensors')).toHaveLength(1);
    });

    it('stops when first page is empty', async () => {
      const transport = new FakePrtgTransport();
      transport.addPage('sensors', [], 0);
      transport.addPage('devices', [], 0);
      const { sensors, devices } = await client(transport).fetchInventory();
      expect(sensors).toEqual([]);
      expect(devices).toEqual([]);
    });

    it('handles total that is exact multiple of page size (5000)', async () => {
      const transport = new FakePrtgTransport();
      // Each page uses unique objids to avoid duplicate detection
      for (let page = 0; page < 10; page++) {
        const fullPage = Array.from({ length: PRTG_PAGE_SIZE }, (_, i) => sensorRow({ objid: page * PRTG_PAGE_SIZE + i + 1 }));
        transport.addPage('sensors', fullPage, 5000);
      }
      transport.addPage('devices', [], 0);

      const { sensors } = await client(transport).fetchInventory();

      expect(sensors).toHaveLength(5000);
      expect(transport.calls.filter((c) => c.table === 'sensors')).toHaveLength(10);
      expect(transport.calls[9]).toEqual({ table: 'sensors', start: 4500, count: 500 });
    });

    it('handles total=0 with empty rows (valid empty inventory)', async () => {
      const transport = new FakePrtgTransport();
      transport.addPage('sensors', [], 0);
      transport.addPage('devices', [], 0);

      const { sensors, devices } = await client(transport).fetchInventory();

      expect(sensors).toEqual([]);
      expect(devices).toEqual([]);
      expect(transport.calls.filter((c) => c.table === 'sensors')).toHaveLength(1);
      expect(transport.calls[0]).toEqual({ table: 'sensors', start: 0, count: PRTG_PAGE_SIZE });
    });

    it('calculates remaining count correctly for last page (306 of 5306)', async () => {
      const transport = new FakePrtgTransport();
      // Each page uses unique objids
      for (let page = 0; page < 10; page++) {
        const fullPage = Array.from({ length: PRTG_PAGE_SIZE }, (_, i) => sensorRow({ objid: page * PRTG_PAGE_SIZE + i + 1 }));
        transport.addPage('sensors', fullPage, 5306);
      }
      const shortPage = Array.from({ length: 306 }, (_, i) => sensorRow({ objid: 5001 + i }));
      transport.addPage('sensors', shortPage, 5306);
      transport.addPage('devices', [], 0);

      const { sensors } = await client(transport).fetchInventory();

      expect(sensors).toHaveLength(5306);
      expect(transport.calls.filter((c) => c.table === 'sensors')).toHaveLength(11);
      expect(transport.calls[10]).toEqual({ table: 'sensors', start: 5000, count: 306 });
    });

    it('does not fetch more pages after total reached', async () => {
      const transport = new FakePrtgTransport();
      const page100 = Array.from({ length: 100 }, (_, i) => sensorRow({ objid: 1 + i }));
      const page100b = Array.from({ length: 100 }, (_, i) => sensorRow({ objid: 101 + i }));
      const page50 = Array.from({ length: 50 }, (_, i) => sensorRow({ objid: 201 + i }));
      transport.addPage('sensors', page100, 250);
      transport.addPage('sensors', page100b, 250);
      transport.addPage('sensors', page50, 250);
      transport.addPage('devices', [], 0);

      const { sensors } = await client(transport).fetchInventory();

      expect(sensors).toHaveLength(250);
      expect(transport.calls.filter((c) => c.table === 'sensors')).toHaveLength(3);
      expect(transport.calls[2]).toEqual({ table: 'sensors', start: 1000, count: 50 });
    });

    it('rejects missing treesize when rows present', async () => {
      const transport = new FakePrtgTransport();
      const fullPage = Array.from({ length: PRTG_PAGE_SIZE }, (_, i) => sensorRow({ objid: 1000 + i }));
      transport.addPage('sensors', fullPage, null);
      transport.addPage('devices', [], 0);

      await expect(client(transport).fetchInventory()).rejects.toThrow('missing treesize');
    });

    it('rejects missing treesize when rows empty (only total=0 is valid empty)', async () => {
      const transport = new FakePrtgTransport();
      transport.addPage('sensors', [], null);
      transport.addPage('devices', [], 0);

      await expect(client(transport).fetchInventory()).rejects.toThrow('missing treesize');
    });

    it('rejects treesize changes across pages', async () => {
      const transport = new FakePrtgTransport();
      const fullPage = Array.from({ length: PRTG_PAGE_SIZE }, (_, i) => sensorRow({ objid: 1000 + i }));
      transport.addPage('sensors', fullPage, 1000);
      transport.addPage('sensors', fullPage, 999);
      transport.addPage('devices', [], 0);

      await expect(client(transport).fetchInventory()).rejects.toThrow('treesize changed');
    });

    it('rejects more rows than remaining total', async () => {
      const transport = new FakePrtgTransport();
      const largePage = Array.from({ length: PRTG_PAGE_SIZE }, (_, i) => sensorRow({ objid: 1000 + i }));
      const overflowPage = Array.from({ length: 10 }, (_, i) => sensorRow({ objid: 2000 + i }));
      transport.addPage('sensors', largePage, 501);
      transport.addPage('sensors', overflowPage, 501);
      transport.addPage('devices', [], 0);

      await expect(client(transport).fetchInventory()).rejects.toThrow('more rows than remaining');
    });
  });

  describe('failure handling', () => {
    it('propagates transport errors on the last page', async () => {
      const transport = new FakePrtgTransport();
      const fullPage = Array.from({ length: PRTG_PAGE_SIZE }, (_, i) => sensorRow({ objid: 3000 + i }));
      transport.addPage('sensors', fullPage, PRTG_PAGE_SIZE + 1);
      transport.throwOnCall = (call) =>
        call.table === 'sensors' && call.start === PRTG_PAGE_SIZE ? new Error('network down') : undefined;
      transport.addPage('devices', [], 0);

      await expect(client(transport).fetchInventory()).rejects.toThrow('network down');
    });

    it('rejects duplicate object IDs within a table', async () => {
      const transport = new FakePrtgTransport();
      transport.addPage('sensors', [sensorRow({ objid: 7 }), sensorRow({ objid: 7, device: 'Other' })], 2);
      transport.addPage('devices', [], 0);
      await expect(client(transport).fetchInventory()).rejects.toThrow('Duplicate object ID');
    });

    it('rejects rows missing required fields', async () => {
      const transport = new FakePrtgTransport();
      transport.addPage('sensors', [{ device: 'Dev', sensor: 'Ping', type: 'Ping' }], 1);
      transport.addPage('devices', [], 0);
      await expect(client(transport).fetchInventory()).rejects.toThrow('Invalid sensors row');
    });

    it('rejects non-positive object IDs', async () => {
      const transport = new FakePrtgTransport();
      transport.addPage('sensors', [sensorRow({ objid: 0 })], 1);
      transport.addPage('devices', [], 0);
      await expect(client(transport).fetchInventory()).rejects.toThrow('Invalid sensors row');
    });

    it('rejects empty page before total reached', async () => {
      const transport = new FakePrtgTransport();
      const fullPage = Array.from({ length: PRTG_PAGE_SIZE }, (_, i) => sensorRow({ objid: 1000 + i }));
      transport.addPage('sensors', fullPage, 5306);
      transport.addPage('sensors', [], 5306);
      transport.addPage('devices', [], 0);

      await expect(client(transport).fetchInventory()).rejects.toThrow('empty page before reaching total');
    });
  });

  describe('devices', () => {
    it('normalizes device rows', async () => {
      const transport = new FakePrtgTransport();
      transport.addPage('sensors', [], 0);
      transport.addPage('devices', [deviceRow({ objid: 5001, device: 'Dev-5001', host: '10.0.0.2', status_raw: '1', status: 'Down', name: '' })], 1);
      const { devices } = await client(transport).fetchInventory();
      expect(devices).toHaveLength(1);
      expect(devices[0]).toEqual({ objectId: 5001, deviceName: 'Dev-5001', host: '10.0.0.2', statusRaw: 1, statusDisplay: 'Down' });
    });
  });
});
