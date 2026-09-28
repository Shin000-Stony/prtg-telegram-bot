import { describe, it, expect } from 'vitest';
import { normalizeSensorStatus, normalizeCustomerStatus, resolveStatusDetail } from '@/modules/status/status.normalizer';
import type { Customer } from '@/modules/customers/customer.types';
import type { PrtgMapping } from '@/modules/mapping/mapping.types';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 1,
    clientId: 'client1',
    name: 'Test Customer',
    monitorType: 'prtg',
    pingHost: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeMapping(overrides: Partial<PrtgMapping> = {}): PrtgMapping {
  return {
    id: 1,
    customerId: 1,
    prtgObjectId: 1001,
    prtgDeviceName: 'Device-A',
    prtgSensorName: 'Ping',
    mappingMethod: 'manual',
    confidence: 0.95,
    verified: true,
    mappedByTelegramId: '12345678',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSensor(objectId: number, raw: number | null, sensorType: string = 'Ping') {
  return {
    objectId,
    deviceName: 'Device-A',
    sensorName: 'Ping',
    sensorType,
    statusRaw: raw,
    statusDisplay: `Status ${raw}`,
    statusMessage: null,
    lastValue: '0.5ms',
    lastUp: null,
    lastDown: null,
  };
}

describe('normalizeSensorStatus', () => {
  const cases: Array<[number | null, string]> = [
    [3, 'UP'],
    [4, 'WARNING'],
    [5, 'DOWN'],
    [13, 'DOWN'],
    [14, 'DOWN'],
    [7, 'PAUSED'],
    [8, 'PAUSED'],
    [9, 'PAUSED'],
    [12, 'PAUSED'],
    [10, 'UNUSUAL'],
    [0, 'UNKNOWN'],
    [1, 'UNKNOWN'],
    [2, 'UNKNOWN'],
    [6, 'UNKNOWN'],
    [11, 'UNKNOWN'],
    [null, 'UNKNOWN'],
    [99, 'UNKNOWN'],
  ];

  for (const [raw, expectedStatus] of cases) {
    it(`raw ${String(raw)} → ${expectedStatus}`, () => {
      const result = normalizeSensorStatus(raw);
      expect(result.status).toBe(expectedStatus);
    });
  }

  it('distinguishes down variants by reason', () => {
    expect(normalizeSensorStatus(5).reason).toBe('down');
    expect(normalizeSensorStatus(13).reason).toBe('down_acknowledged');
    expect(normalizeSensorStatus(14).reason).toBe('down_partial');
  });
});

describe('normalizeCustomerStatus - precedence', () => {
  it('disabled customer → DISABLED regardless of mapping/sensor', () => {
    const result = normalizeCustomerStatus({
      customer: makeCustomer({ enabled: false }),
      sensor: makeSensor(1001, 3),
      mapping: makeMapping(),
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: null,
    });
    expect(result.status).toBe('DISABLED');
    expect(result.dataQuality).toBe('not_applicable');
  });

  it('monitorType=disabled with enabled=true → DISABLED', () => {
    const result = normalizeCustomerStatus({
      customer: makeCustomer({ enabled: true, monitorType: 'disabled' }),
      sensor: makeSensor(1001, 3),
      mapping: makeMapping(),
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: null,
    });
    expect(result.status).toBe('DISABLED');
    expect(result.dataQuality).toBe('not_applicable');
  });

  it('PIC customer → PIC_MANAGED', () => {
    const result = normalizeCustomerStatus({
      customer: makeCustomer({ monitorType: 'pic' }),
      sensor: null,
      mapping: null,
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: null,
    });
    expect(result.status).toBe('PIC_MANAGED');
    expect(result.dataQuality).toBe('not_applicable');
  });

  it('ICMP customer without monitoring config → NOT_CHECKED/unavailable', () => {
    const result = normalizeCustomerStatus({
      customer: makeCustomer({ monitorType: 'icmp' }),
      sensor: null,
      mapping: null,
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: null,
      monitoringState: null,
      icmpFreshThresholdMs: 60000,
      icmpNow: () => Date.now(),
    });
    expect(result.status).toBe('NOT_CHECKED');
    expect(result.reason).toBe('not_checked');
    expect(result.dataQuality).toBe('unavailable');
  });

  it('PRTG customer without mapping → UNMAPPED', () => {
    const result = normalizeCustomerStatus({
      customer: makeCustomer({ monitorType: 'prtg' }),
      sensor: null,
      mapping: null,
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: null,
    });
    expect(result.status).toBe('UNMAPPED');
    expect(result.dataQuality).toBe('not_applicable');
  });

  it('unavailable data quality → UNKNOWN', () => {
    const result = normalizeCustomerStatus({
      customer: makeCustomer(),
      sensor: makeSensor(1001, 5),
      mapping: makeMapping(),
      dataQuality: 'unavailable',
      fetchedAt: null,
      lastKnownStatus: null,
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('no_snapshot');
    expect(result.dataQuality).toBe('unavailable');
  });

  it('stale data → UNKNOWN effective status with lastKnownStatus as info only', () => {
    const result = normalizeCustomerStatus({
      customer: makeCustomer(),
      sensor: makeSensor(1001, 5),
      mapping: makeMapping(),
      dataQuality: 'stale',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: 'DOWN',
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('snapshot_stale');
    expect(result.dataQuality).toBe('stale');
  });

  it('sensor missing in inventory → UNKNOWN sensor_not_found', () => {
    const result = normalizeCustomerStatus({
      customer: makeCustomer(),
      sensor: null,
      mapping: makeMapping(),
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: null,
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('sensor_not_found');
  });

  it('non-ping sensor → UNKNOWN target_not_ping', () => {
    const result = normalizeCustomerStatus({
      customer: makeCustomer(),
      sensor: makeSensor(1001, 3, 'HTTP'),
      mapping: makeMapping(),
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: null,
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('target_not_ping');
  });

  it('fresh data with ping sensor down → DOWN', () => {
    const result = normalizeCustomerStatus({
      customer: makeCustomer(),
      sensor: makeSensor(1001, 5),
      mapping: makeMapping(),
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: 'UP',
    });
    expect(result.status).toBe('DOWN');
    expect(result.dataQuality).toBe('fresh');
  });

  it('fresh data with ping sensor up → UP', () => {
    const result = normalizeCustomerStatus({
      customer: makeCustomer(),
      sensor: makeSensor(1001, 3),
      mapping: makeMapping(),
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: null,
    });
    expect(result.status).toBe('UP');
  });
});

describe('normalizeCustomerStatus - display text vs raw', () => {
  it('statusDisplay string is not used as source of truth', () => {
    const sensor = makeSensor(1001, 5);
    sensor.statusDisplay = 'UP';

    const result = normalizeCustomerStatus({
      customer: makeCustomer(),
      sensor,
      mapping: makeMapping(),
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: null,
    });
    expect(result.status).toBe('DOWN');
  });
});

describe('resolveStatusDetail - lastKnownStatus handling', () => {
  it('stale detail has effective UNKNOWN but lastKnownStatus populated', () => {
    const detail = resolveStatusDetail({
      customer: makeCustomer(),
      sensor: makeSensor(1001, 5),
      mapping: makeMapping(),
      dataQuality: 'stale',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: 'DOWN',
    });
    expect(detail.status).toBe('UNKNOWN');
    expect(detail.dataQuality).toBe('stale');
    expect(detail.lastKnownStatus).toBe('DOWN');
  });

  it('fresh detail has lastKnownStatus as null', () => {
    const detail = resolveStatusDetail({
      customer: makeCustomer(),
      sensor: makeSensor(1001, 3),
      mapping: makeMapping(),
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: 'DOWN',
    });
    expect(detail.status).toBe('UP');
    expect(detail.lastKnownStatus).toBeNull();
  });

  it('empty lastValue → null', () => {
    const sensor = makeSensor(1001, 3);
    sensor.lastValue = null;
    const detail = resolveStatusDetail({
      customer: makeCustomer(),
      sensor,
      mapping: makeMapping(),
      dataQuality: 'fresh',
      fetchedAt: '2026-01-01T00:00:00Z',
      lastKnownStatus: null,
    });
    expect(detail.lastValue).toBeNull();
  });
});
