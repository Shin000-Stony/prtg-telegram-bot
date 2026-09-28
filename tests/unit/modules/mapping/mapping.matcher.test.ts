import { describe, it, expect } from 'vitest';
import { runMatcher, findMappingCandidates, evaluateMappingDecision, clientIdMatchesDeviceName, calculateNameMatch, normalizeName, tokenize, jaccardSimilarity, isEligiblePing } from '@/modules/mapping/mapping.matcher';
import type { Customer } from '@/modules/customers/customer.types';
import type { PrtgObjectCandidate } from '@/integrations/prtg/prtg.types';
import type { PrtgMapping, MappingCandidate, MappingDecision, MatcherInput } from '@/modules/mapping/mapping.types';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 1,
    clientId: '11',
    name: 'HENGJAYA',
    monitorType: 'prtg',
    pingHost: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<PrtgObjectCandidate> = {}): PrtgObjectCandidate {
  return {
    objectId: 4036,
    deviceName: 'Device-11',
    sensorName: 'Ping',
    sensorType: 'Ping',
    status: 'Up',
    ...overrides,
  };
}

function makeMapping(overrides: Partial<PrtgMapping> = {}): PrtgMapping {
  return {
    id: 1,
    customerId: 1,
    prtgObjectId: 4036,
    prtgDeviceName: 'Device-11',
    prtgSensorName: 'Ping',
    mappingMethod: 'auto',
    confidence: 0.98,
    verified: false,
    mappedByTelegramId: '123',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeInput(overrides: Partial<MatcherInput> = {}): MatcherInput {
  return {
    customer: makeCustomer(),
    inventory: [makeCandidate()],
    existingMappings: [],
    ...overrides,
  };
}

describe('Matcher utilities', () => {
  describe('normalizeName', () => {
    it('normalizes unicode, case, and collapses whitespace', () => {
      expect(normalizeName('  HENGJAYA  ')).toBe('hengjaya');
      expect(normalizeName('MikroTik-RB')).toBe('mikrotik rb');
      expect(normalizeName('Client_001')).toBe('client 001');
    });
  });

  describe('tokenize', () => {
    it('splits on non-alphanumeric boundaries', () => {
      expect(tokenize('HENGJAYA Data Center')).toEqual(['hengjaya', 'data', 'center']);
      expect(tokenize('Client-11-Server')).toEqual(['client', '11', 'server']);
      expect(tokenize('  ')).toEqual([]);
    });
  });

  describe('jaccardSimilarity', () => {
    it('calculates Jaccard index', () => {
      expect(jaccardSimilarity(['a', 'b', 'c'], ['a', 'b', 'd'])).toBeCloseTo(0.5);
      expect(jaccardSimilarity(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(0.5);
      expect(jaccardSimilarity([], ['a'])).toBe(0);
    });
  });

  describe('clientIdMatchesDeviceName', () => {
    it('detects exact match for >=6 chars', () => {
      const r = clientIdMatchesDeviceName('001234', '001234');
      expect(r.full).toBe(true);
      expect(r.token).toBe(true);
    });

    it('rejects short client_id exact match (<6 chars)', () => {
      const r = clientIdMatchesDeviceName('11', '11');
      expect(r.full).toBe(false);
      expect(r.token).toBe(false);
    });

    it('rejects substring match without boundaries', () => {
      const r = clientIdMatchesDeviceName('8', '3876');
      expect(r.full).toBe(false);
      expect(r.token).toBe(false);
    });

    it('rejects short client_id (<6 chars)', () => {
      const r = clientIdMatchesDeviceName('11', 'Device-11');
      expect(r.full).toBe(false);
      expect(r.token).toBe(false);
    });

    it('preserves leading zeros', () => {
      const r = clientIdMatchesDeviceName('001234', 'Device-1234');
      expect(r.token).toBe(false);
    });
  });

  describe('calculateNameMatch', () => {
    it('detects exact name match', () => {
      const r = calculateNameMatch('HENGJAYA', 'HENGJAYA');
      expect(r.exact).toBe(true);
      expect(r.jaccard).toBe(1);
    });

    it('detects partial match with Jaccard >=0.6 and >=2 tokens', () => {
      const r = calculateNameMatch('HENGJAYA Data', 'HENGJAYA Data Center');
      expect(r.exact).toBe(false);
      expect(r.partial).toBe(true);
      expect(r.jaccard).toBeGreaterThanOrEqual(0.6);
    });

    it('rejects single token partial match', () => {
      const r = calculateNameMatch('HENGJAYA', 'HENGJAYA Data Center');
      expect(r.partial).toBe(false);
    });

    it('rejects low Jaccard', () => {
      const r = calculateNameMatch('HENGJAYA', 'UNRELATED');
      expect(r.partial).toBe(false);
    });
  });

  describe('isEligiblePing', () => {
    it('accepts Ping case-insensitive', () => {
      expect(isEligiblePing({ sensorType: 'Ping', objectId: 1, deviceName: 'D', sensorName: 'S', status: '' })).toBe(true);
      expect(isEligiblePing({ sensorType: 'ping', objectId: 1, deviceName: 'D', sensorName: 'S', status: '' })).toBe(true);
      expect(isEligiblePing({ sensorType: 'PING', objectId: 1, deviceName: 'D', sensorName: 'S', status: '' })).toBe(true);
    });

    it('rejects non-Ping types', () => {
      expect(isEligiblePing({ sensorType: 'HTTP', objectId: 1, deviceName: 'D', sensorName: 'S', status: '' })).toBe(false);
      expect(isEligiblePing({ sensorType: 'SNMP', objectId: 1, deviceName: 'D', sensorName: 'S', status: '' })).toBe(false);
    });
  });
});

describe('Conservative Matcher (runMatcher)', () => {
  const baseInput = makeInput();

  it('returns unresolved for disabled customer', () => {
    const decision = runMatcher({ ...baseInput, customer: makeCustomer({ enabled: false }) });
    expect(decision.kind).toBe('unresolved');
  });

  it('returns unresolved for non-PRTG customer', () => {
    const decision = runMatcher({ ...baseInput, customer: makeCustomer({ monitorType: 'icmp' }) });
    expect(decision.kind).toBe('unresolved');
  });

  it('returns unresolved for empty inventory', () => {
    const decision = runMatcher({ ...baseInput, inventory: [] });
    expect(decision.kind).toBe('unresolved');
  });

  it('returns unresolved for no eligible Ping sensors', () => {
    const decision = runMatcher({
      ...baseInput,
      inventory: [makeCandidate({ sensorType: 'HTTP', objectId: 1 })],
    });
    expect(decision.kind).toBe('unresolved');
  });

  describe('AUTO decision', () => {
    it('auto-maps exact client_id >=6 chars with single eligible Ping', () => {
      const decision = runMatcher({
        ...baseInput,
        customer: makeCustomer({ clientId: '001234' }),
        inventory: [makeCandidate({ deviceName: 'Server-001234', objectId: 4036 })],
      });
      expect(decision.kind).toBe('automatic');
      if (decision.kind === 'automatic') {
        expect(decision.objectId).toBe(4036);
        expect(decision.confidence).toBe(0.98);
      }
    });

    it('auto-maps exact client_id match (full device name)', () => {
      const decision = runMatcher({
        ...baseInput,
        customer: makeCustomer({ clientId: '001234' }),
        inventory: [makeCandidate({ deviceName: '001234', objectId: 4036 })],
      });
      expect(decision.kind).toBe('automatic');
      if (decision.kind === 'automatic') {
        expect(decision.confidence).toBe(1.0);
      }
    });

    it('does NOT auto-map short client_id (8) matching substring (3876)', () => {
      const decision = runMatcher({
        ...baseInput,
        customer: makeCustomer({ clientId: '8' }),
        inventory: [makeCandidate({ deviceName: 'Device-3876', objectId: 3876 })],
      });
      expect(decision.kind).not.toBe('automatic');
    });

    it('does NOT auto-map leading zeros mismatch (001234 vs 1234)', () => {
      const decision = runMatcher({
        ...baseInput,
        customer: makeCustomer({ clientId: '001234' }),
        inventory: [makeCandidate({ deviceName: 'Device-1234', objectId: 3876 })],
      });
      expect(decision.kind).not.toBe('automatic');
    });

    it('does NOT auto-map when multiple eligible Ping have same client_id (conflict)', () => {
      const decision = runMatcher({
        ...baseInput,
        customer: makeCustomer({ clientId: '001234' }),
        inventory: [
          makeCandidate({ deviceName: 'Server-001234-Main', objectId: 4036 }),
          makeCandidate({ deviceName: 'Server-001234-Backup', objectId: 3876 }),
        ],
      });
      expect(decision.kind).toBe('suggestions');
    });

    it('does NOT auto-map when sensor already claimed by another customer', () => {
      const decision = runMatcher({
        ...baseInput,
        customer: makeCustomer({ clientId: '001234' }),
        inventory: [makeCandidate({ deviceName: 'Server-001234', objectId: 4036 })],
        existingMappings: [makeMapping({ customerId: 2, prtgObjectId: 4036 })],
      });
      expect(decision.kind).toBe('suggestions');
      if (decision.kind === 'suggestions') {
        expect(decision.candidates[0].conflictReason).toContain('claimed by customer 2');
      }
    });
  });

  describe('SUGGESTIONS decision', () => {
    it('suggests exact customer name match (0.90)', () => {
      const decision = runMatcher({
        ...baseInput,
        inventory: [makeCandidate({ deviceName: 'HENGJAYA', objectId: 4036 })],
      });
      expect(decision.kind).toBe('suggestions');
      if (decision.kind === 'suggestions') {
        expect(decision.candidates[0].confidence).toBe(0.9);
      }
    });

    it('suggests partial name match with Jaccard >=0.6 (0.65)', () => {
      const decision = runMatcher({
        ...baseInput,
        customer: makeCustomer({ name: 'HENGJAYA Data' }),
        inventory: [makeCandidate({ deviceName: 'HENGJAYA Data Center', objectId: 4036 })],
      });
      expect(decision.kind).toBe('suggestions');
      if (decision.kind === 'suggestions') {
        expect(decision.candidates[0].confidence).toBe(0.65);
      }
    });

    it('includes conflict candidates in suggestions', () => {
      const decision = runMatcher({
        ...baseInput,
        customer: makeCustomer({ clientId: '001234' }),
        inventory: [makeCandidate({ deviceName: 'Server-001234', objectId: 4036 })],
        existingMappings: [makeMapping({ customerId: 2, prtgObjectId: 4036 })],
      });
      expect(decision.kind).toBe('suggestions');
      if (decision.kind === 'suggestions') {
        expect(decision.candidates[0].conflictReason).toBeDefined();
      }
    });
  });

  describe('UNRESOLVED decision', () => {
    it('unresolved for short client_id without name support', () => {
      const decision = runMatcher({
        ...baseInput,
        customer: makeCustomer({ clientId: '8', name: 'ANUGRAH' }),
        inventory: [makeCandidate({ deviceName: 'Device-3876', objectId: 3876 })],
      });
      expect(decision.kind).toBe('unresolved');
    });

    it('unresolved for generic single-token name', () => {
      const decision = runMatcher({
        ...baseInput,
        customer: makeCustomer({ name: 'MikroTik' }),
        inventory: [makeCandidate({ deviceName: 'MikroTik Router', objectId: 4036 })],
      });
      expect(decision.kind).toBe('unresolved');
    });

    it('unresolved for unrelated Ping', () => {
      const decision = runMatcher({
        ...baseInput,
        inventory: [makeCandidate({ deviceName: 'UNRELATED-DEVICE', objectId: 9999 })],
      });
      expect(decision.kind).toBe('unresolved');
    });
  });

  describe('deterministic ordering', () => {
    it('orders by confidence desc then objectId asc', () => {
      const decision = runMatcher({
        ...baseInput,
        customer: makeCustomer({ name: 'HENGJAYA Data Center' }),
        inventory: [
          makeCandidate({ deviceName: 'HENGJAYA Data', objectId: 1001, sensorType: 'Ping' }),
          makeCandidate({ deviceName: 'Client-001234', objectId: 1002, sensorType: 'Ping' }),
          makeCandidate({ deviceName: 'HENGJAYA Data Center', objectId: 1003, sensorType: 'Ping' }),
        ],
      });
      expect(decision.kind).toBe('suggestions');
      if (decision.kind === 'suggestions') {
        expect(decision.candidates.length).toBeGreaterThanOrEqual(2);
        expect(decision.candidates[0].confidence).toBeGreaterThanOrEqual(decision.candidates[1].confidence);
        if (decision.candidates[0].confidence === decision.candidates[1].confidence) {
          expect(decision.candidates[0].prtgObjectId).toBeLessThan(decision.candidates[1].prtgObjectId);
        }
      } else {
        throw new Error('Expected suggestions decision');
      }
    });
  });
});

describe('evaluateMappingDecision', () => {
  it('returns unresolved for empty candidates', () => {
    const decision = evaluateMappingDecision([]);
    expect(decision.kind).toBe('unresolved');
  });

  it('returns automatic for single high-confidence candidate without conflict', () => {
    const candidates: MappingCandidate[] = [{
      prtgObjectId: 4036,
      deviceName: 'Client-001234',
      sensorName: 'Ping',
      sensorType: 'Ping',
      matchReason: 'exact client_id match',
      confidence: 0.98,
    }];
    const decision = evaluateMappingDecision(candidates);
    expect(decision.kind).toBe('automatic');
  });

  it('returns suggestions for multiple high-confidence candidates', () => {
    const candidates: MappingCandidate[] = [
      { prtgObjectId: 4036, deviceName: 'Client-001234', sensorName: 'Ping', sensorType: 'Ping', matchReason: 'strong', confidence: 0.98 },
      { prtgObjectId: 3876, deviceName: 'Client-001234-Backup', sensorName: 'Ping', sensorType: 'Ping', matchReason: 'strong', confidence: 0.95 },
    ];
    const decision = evaluateMappingDecision(candidates);
    expect(decision.kind).toBe('suggestions');
  });

  it('returns suggestions for moderate confidence', () => {
    const candidates: MappingCandidate[] = [{
      prtgObjectId: 4036, deviceName: 'HENGJAYA', sensorName: 'Ping', sensorType: 'Ping', matchReason: 'moderate', confidence: 0.65,
    }];
    const decision = evaluateMappingDecision(candidates);
    expect(decision.kind).toBe('suggestions');
  });

  it('returns unresolved for low confidence', () => {
    const candidates: MappingCandidate[] = [{
      prtgObjectId: 4036, deviceName: 'Weak', sensorName: 'Ping', sensorType: 'Ping', matchReason: 'weak', confidence: 0.3,
    }];
    const decision = evaluateMappingDecision(candidates);
    expect(decision.kind).toBe('unresolved');
  });

  it('filters out conflicted candidates from auto but keeps in suggestions', () => {
    const candidates: MappingCandidate[] = [
      { prtgObjectId: 4036, deviceName: 'Client-001234', sensorName: 'Ping', sensorType: 'Ping', matchReason: 'exact client_id match', confidence: 0.98, conflictReason: 'claimed by customer 2' },
    ];
    const decision = evaluateMappingDecision(candidates);
    expect(decision.kind).toBe('suggestions');
  });
});