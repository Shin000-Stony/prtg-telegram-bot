import type { MappingCandidate, MappingDecision } from './mapping.types';
import type { PrtgObjectCandidate } from '@/integrations/prtg/prtg.types';
import type { Customer } from '../customers/customer.types';
import type { PrtgMapping } from './mapping.types';

export interface MatcherInput {
  customer: Customer;
  inventory: PrtgObjectCandidate[];
  existingMappings: PrtgMapping[];
}

function normalizeName(str: string): string {
  return str
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(str: string): string[] {
  return normalizeName(str).split(' ').filter(Boolean);
}

function jaccardSimilarity(tokens1: string[], tokens2: string[]): number {
  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

function clientIdMatchesDeviceName(clientId: string, deviceName: string): { full: boolean; token: boolean } {
  const normClientId = clientId.toLowerCase();
  const normDevice = deviceName.toLowerCase();

  if (normClientId.length < 6) {
    return { full: false, token: false };
  }

  const exactMatch = normDevice === normClientId;
  if (exactMatch) {
    return { full: true, token: true };
  }

  const boundaryRegex = new RegExp(`(^|[^a-z0-9])${normClientId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
  const tokenMatch = boundaryRegex.test(normDevice);

  return { full: false, token: tokenMatch };
}

function calculateNameMatch(customerName: string, deviceName: string): { exact: boolean; partial: boolean; jaccard: number; tokenCount: number } {
  const normCustomer = normalizeName(customerName);
  const normDevice = normalizeName(deviceName);

  if (normCustomer === normDevice) {
    return { exact: true, partial: false, jaccard: 1, tokenCount: tokenize(normCustomer).length };
  }

  const customerTokens = tokenize(normCustomer);
  const deviceTokens = tokenize(normDevice);
  const jaccard = jaccardSimilarity(customerTokens, deviceTokens);
  const partial = jaccard >= 0.6 && customerTokens.length >= 2 && deviceTokens.length >= 2;

  return { exact: false, partial, jaccard, tokenCount: customerTokens.length };
}

function isEligiblePing(sensor: PrtgObjectCandidate): boolean {
  return sensor.sensorType.toLowerCase() === 'ping';
}

function buildCandidates(input: MatcherInput): MappingCandidate[] {
  const { customer, inventory, existingMappings } = input;

  if (!customer.enabled || customer.monitorType !== 'prtg') {
    return [];
  }

  const ownedObjectIds = new Set(
    existingMappings.filter((m) => m.customerId === customer.id).map((m) => m.prtgObjectId)
  );
  const otherCustomerMappings = new Map<number, number>(); // objectId -> customerId
  for (const m of existingMappings) {
    if (m.customerId !== customer.id) {
      otherCustomerMappings.set(m.prtgObjectId, m.customerId);
    }
  }

  const results: MappingCandidate[] = [];

  for (const sensor of inventory) {
    if (!isEligiblePing(sensor)) {
      continue;
    }

    if (ownedObjectIds.has(sensor.objectId)) {
      continue;
    }

    const otherOwner = otherCustomerMappings.get(sensor.objectId);
    const conflictReason = otherOwner ? `claimed by customer ${otherOwner}` : undefined;

    const { full: clientIdFull, token: clientIdToken } = clientIdMatchesDeviceName(customer.clientId, sensor.deviceName);
    const { exact: nameExact, partial: namePartial, jaccard, tokenCount } = calculateNameMatch(customer.name, sensor.deviceName);

    const reasons: string[] = [];
    let confidence = 0;

    if (clientIdFull) {
      reasons.push('exact client_id match with device name');
      confidence = 1.0;
    } else if (clientIdToken) {
      reasons.push('client_id as full token in device name');
      confidence = 0.98;
    }

    if (nameExact) {
      reasons.push('exact customer name match with device name');
      confidence = Math.max(confidence, 0.9);
    } else if (namePartial) {
      reasons.push(`partial name match (Jaccard ${Math.round(jaccard * 100)}%, ${tokenCount} tokens)`);
      confidence = Math.max(confidence, 0.65);
    }

    if (reasons.length > 0) {
      results.push({
        prtgObjectId: sensor.objectId,
        deviceName: sensor.deviceName,
        sensorName: sensor.sensorName,
        sensorType: sensor.sensorType,
        matchReason: reasons.join('; '),
        confidence: Math.round(confidence * 100) / 100,
        conflictReason,
      });
    }
  }

  results.sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return a.prtgObjectId - b.prtgObjectId;
  });

  return results;
}

export function evaluateMappingDecision(candidates: MappingCandidate[]): MappingDecision {
  if (candidates.length === 0) {
    return { kind: 'unresolved', reason: 'No eligible Ping sensors matched the customer' };
  }

  const autoEligible = candidates.filter((c) => c.confidence >= 0.98);
  if (autoEligible.length === 1) {
    const best = autoEligible[0];
    if (!best.conflictReason && (best.matchReason.includes('exact client_id match') || best.matchReason.includes('client_id as full token'))) {
      return {
        kind: 'automatic',
        objectId: best.prtgObjectId,
        confidence: best.confidence,
        reason: best.matchReason,
      };
    }
  }

  const suggestions = candidates.filter((c) => c.confidence >= 0.65);
  if (suggestions.length > 0) {
    return {
      kind: 'suggestions',
      candidates: suggestions,
    };
  }

  return { kind: 'unresolved', reason: 'No eligible Ping sensors met minimum confidence threshold' };
}

export function runMatcher(input: MatcherInput): MappingDecision {
  const candidates = buildCandidates(input);
  return evaluateMappingDecision(candidates);
}

export function findMappingCandidates(input: MatcherInput): MappingCandidate[] {
  return buildCandidates(input);
}

export { buildCandidates, clientIdMatchesDeviceName, calculateNameMatch, normalizeName, tokenize, jaccardSimilarity, isEligiblePing };