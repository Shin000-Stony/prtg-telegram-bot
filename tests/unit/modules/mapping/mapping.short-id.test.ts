import { describe, it, expect } from 'vitest';
import { runMatcher, clientIdMatchesDeviceName } from '@/modules/mapping/mapping.matcher';
import type { Customer } from '@/modules/customers/customer.types';
import type { PrtgObjectCandidate } from '@/integrations/prtg/prtg.types';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 1,
    clientId: '001234',
    name: 'HENGJAYA',
    monitorType: 'prtg',
    pingHost: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSensor(overrides: Partial<PrtgObjectCandidate> = {}): PrtgObjectCandidate {
  return {
    objectId: 4036,
    deviceName: 'Device-001234',
    sensorName: 'Ping',
    sensorType: 'Ping',
    ...overrides,
  };
}

describe('R5: Matcher short ID rejection', () => {
  describe('clientIdMatchesDeviceName', () => {
    it('rejects exact match for short client_id (< 6 chars)', () => {
      const result = clientIdMatchesDeviceName('8', '8');
      expect(result).toEqual({ full: false, token: false });
    });

    it('rejects token match for short client_id', () => {
      const result = clientIdMatchesDeviceName('8', 'Device-8');
      expect(result).toEqual({ full: false, token: false });
    });

    it('accepts exact match for long client_id (>= 6 chars)', () => {
      const result = clientIdMatchesDeviceName('001234', '001234');
      expect(result).toEqual({ full: true, token: true });
    });

    it('accepts token match for long client_id with boundaries', () => {
      const result = clientIdMatchesDeviceName('001234', 'Server-001234');
      expect(result).toEqual({ full: false, token: true });
    });

    it('rejects leading zeros mismatch as exact match', () => {
      const result = clientIdMatchesDeviceName('001234', '1234');
      expect(result.full).toBe(false);
      expect(result.token).toBe(false);
    });

    it('does not match short ID as substring in longer ID', () => {
      const result = clientIdMatchesDeviceName('8', '3876');
      expect(result).toEqual({ full: false, token: false });
    });
  });

  describe('runMatcher AUTO decision', () => {
    it('does NOT auto-map short client_id (8) matching substring (3876)', () => {
      const decision = runMatcher({
        customer: makeCustomer({ clientId: '8', name: 'ANUGRAH' }),
        inventory: [makeSensor({ deviceName: 'Device-3876', objectId: 3876 })],
        existingMappings: [],
      });
      expect(decision.kind).not.toBe('automatic');
    });

    it('does NOT auto-map short client_id even with exact device match', () => {
      const decision = runMatcher({
        customer: makeCustomer({ clientId: '8', name: 'Test' }),
        inventory: [makeSensor({ deviceName: '8', objectId: 1001 })],
        existingMappings: [],
      });
      expect(decision.kind).not.toBe('automatic');
      expect(decision.kind).toBe('unresolved');
    });
  });
});
