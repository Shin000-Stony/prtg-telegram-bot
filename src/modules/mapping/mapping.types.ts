import type { MappingMethod } from '../../config/constants';
import type { Customer } from '../customers/customer.types';
import type { PrtgObjectCandidate } from '@/integrations/prtg/prtg.types';

export interface PrtgMapping {
  id: number;
  customerId: number;
  prtgObjectId: number;
  prtgDeviceName: string | null;
  prtgSensorName: string | null;
  mappingMethod: MappingMethod;
  confidence: number | null;
  verified: boolean;
  mappedByTelegramId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMappingInput {
  customerId: number;
  prtgObjectId: number;
  prtgDeviceName?: string | null;
  prtgSensorName?: string | null;
  mappingMethod: MappingMethod;
  confidence?: number | null;
  verified?: boolean;
  mappedByTelegramId?: string | null;
}

export interface UpdateMappingInput {
  prtgObjectId?: number;
  prtgDeviceName?: string | null;
  prtgSensorName?: string | null;
  mappingMethod?: MappingMethod;
  confidence?: number | null;
  verified?: boolean;
  mappedByTelegramId?: string | null;
}

export interface MappingCandidate {
  prtgObjectId: number;
  deviceName: string;
  sensorName: string;
  sensorType: string;
  matchReason: string;
  confidence: number;
  conflictReason?: string;
}

export interface MatcherInput {
  customer: Customer;
  inventory: PrtgObjectCandidate[];
  existingMappings: PrtgMapping[];
}

export type MappingDecision =
  | {
      kind: 'automatic';
      objectId: number;
      confidence: number;
      reason: string;
    }
  | {
      kind: 'suggestions';
      candidates: MappingCandidate[];
    }
  | {
      kind: 'unresolved';
      reason: string;
    };

export function isAutomaticDecision(decision: MappingDecision): decision is Extract<MappingDecision, { kind: 'automatic' }> {
  return decision.kind === 'automatic';
}

export function isSuggestionsDecision(decision: MappingDecision): decision is Extract<MappingDecision, { kind: 'suggestions' }> {
  return decision.kind === 'suggestions';
}

export function isUnresolvedDecision(decision: MappingDecision): decision is Extract<MappingDecision, { kind: 'unresolved' }> {
  return decision.kind === 'unresolved';
}