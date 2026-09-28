import { mappingRepository } from './mapping.repository';
import { runMatcher } from './mapping.matcher';
import { pendingMappingStore } from './pending-mapping.store';
import type { PrtgMapping, CreateMappingInput, UpdateMappingInput, MappingDecision, MappingCandidate, MatcherInput } from './mapping.types';
import type { Customer } from '../customers/customer.types';
import type { InventorySnapshot } from '@/integrations/prtg/prtg.inventory.cache';
import { accessService } from '../groups/access.service';
import { customerService } from '../customers/customer.service';
import { AppError } from '../../core/errors/app-error';
import { getLogger } from '../../core/logger';

const logger = getLogger().child({ module: 'MappingService' });

const INVENTORY_MAX_AGE_MS = 5 * 60_000;

function isInventoryStale(inventory: InventorySnapshot): boolean {
  const fetchedAtMs = new Date(inventory.fetchedAt).getTime();
  return Date.now() - fetchedAtMs > INVENTORY_MAX_AGE_MS;
}

export interface MappingPreview {
  customer: { id: number; clientId: string; name: string; enabled: boolean; monitorType: string };
  sensor: { objectId: number; deviceName: string; sensorName: string; sensorType: string };
  existingMapping?: PrtgMapping;
  conflictReason?: string;
}

export interface AutoMappingPreview {
  automatic: Array<{ customerId: number; clientId: string; name: string; objectId: number; confidence: number; reason: string }>;
  suggestions: Array<{ customerId: number; clientId: string; name: string; candidates: MappingCandidate[] }>;
  unresolved: Array<{ customerId: number; clientId: string; name: string; reason: string }>;
}

export interface AutoMappingPreviewResult {
  token: string;
  preview: AutoMappingPreview;
}

export class MappingService {
  getByCustomerId(customerId: number): PrtgMapping | null {
    return mappingRepository.findByCustomerId(customerId);
  }

  getById(id: number): PrtgMapping | null {
    return mappingRepository.findById(id);
  }

  getAllVerified(): PrtgMapping[] {
    return mappingRepository.findAllVerified();
  }

  getAllMappings(): PrtgMapping[] {
    return mappingRepository.findAll();
  }

  getAllWithDetails(): Array<PrtgMapping & { clientId: string; customerName: string }> {
    return mappingRepository.findAllWithCustomer();
  }

  createManualMapping(input: CreateMappingInput): PrtgMapping {
    logger.info({ customerId: input.customerId, prtgObjectId: input.prtgObjectId }, 'Creating manual mapping');

    const existing = mappingRepository.findByCustomerId(input.customerId);
    if (existing) {
      throw AppError.validation('Customer already has a mapping', { customerId: input.customerId });
    }

    return mappingRepository.create({
      ...input,
      mappingMethod: 'manual',
      verified: true,
    });
  }

  updateMapping(id: number, input: UpdateMappingInput): PrtgMapping {
    logger.info({ id }, 'Updating mapping');

    const updated = mappingRepository.update(id, input);
    if (!updated) {
      throw AppError.notFound('Mapping not found', { id });
    }
    return updated;
  }

  deleteMapping(customerId: number): boolean {
    logger.info({ customerId }, 'Deleting mapping');
    return mappingRepository.deleteByCustomerId(customerId);
  }

  evaluateAutoMapping(input: MatcherInput): MappingDecision {
    return runMatcher(input);
  }

  createFromDecision(customerId: number, decision: MappingDecision, mappedByTelegramId: string): PrtgMapping {
    if (decision.kind !== 'automatic') {
      throw AppError.validation('Cannot create mapping from non-automatic decision', { decisionKind: decision.kind });
    }

    return mappingRepository.create({
      customerId,
      prtgObjectId: decision.objectId,
      mappingMethod: 'auto',
      confidence: decision.confidence,
      verified: false,
      mappedByTelegramId,
    });
  }

  getStats(): { total: number; verified: number } {
    return {
      total: mappingRepository.count(),
      verified: mappingRepository.countVerified(),
    };
  }

  findCandidatesForCustomer(customer: Customer, inventory: PrtgObjectCandidate[], existingMappings: PrtgMapping[]): MappingCandidate[] {
    const decision = runMatcher({ customer, inventory, existingMappings });
    return decision.kind === 'suggestions' ? decision.candidates : [];
  }

  // V4 API methods

  getMappingDetail(clientId: string, context: { userId: string; chatId: string; chatType: string }): PrtgMapping | null {
    const customer = customerService.getByClientId(clientId);
    if (!customer) {
      throw AppError.notFound('Customer not found', { clientId });
    }

    // Check access
    if (!accessService.canViewCustomer(context, customer.id)) {
      throw AppError.forbidden('Access denied to this customer');
    }

    return this.getByCustomerId(customer.id);
  }

  prepareMapping(
    clientId: string,
    objectId: number,
    context: { userId: string; chatId: string; chatType: string },
    inventory: InventorySnapshot
  ): { token: string; preview: MappingPreview } {
    // Check permission
    if (!accessService.canManageMappings(context)) {
      throw AppError.forbidden('Admin access required for mapping operations');
    }

    const customer = customerService.getByClientId(clientId);
    if (!customer) {
      throw AppError.notFound('Customer not found', { clientId });
    }

    if (!customer.enabled || customer.monitorType !== 'prtg') {
      throw AppError.validation('Customer must be enabled and use PRTG monitor type', { clientId });
    }

     // Check existing mapping
    const existingMapping = mappingRepository.findByCustomerId(customer.id) ?? undefined;
    if (existingMapping) {
      // Allow verification of existing AUTO mapping to the same sensor
      if (existingMapping.prtgObjectId === objectId && !existingMapping.verified && existingMapping.mappingMethod === 'auto') {
        // Fall through - allow verification
      } else {
        throw AppError.validation('Customer already has a mapping', { clientId });
      }
    }

    // Find sensor in inventory
    const sensor = inventory.sensors.find(s => s.objectId === objectId);
    if (!sensor) {
      throw AppError.notFound('PRTG sensor not found in current inventory', { objectId });
    }

    if (sensor.sensorType.toLowerCase() !== 'ping') {
      throw AppError.validation('Only Ping sensors can be mapped', { objectId, sensorType: sensor.sensorType });
    }

    // Check if sensor already mapped to another customer
    const otherMapping = mappingRepository.findByPrtgObjectId(objectId);
    let conflictReason: string | undefined;
    if (otherMapping && otherMapping.customerId !== customer.id) {
      conflictReason = `Sensor already mapped to another customer`;
    }

    const preview: MappingPreview = {
      customer: { id: customer.id, clientId: customer.clientId, name: customer.name, enabled: customer.enabled, monitorType: customer.monitorType },
      sensor: { objectId: sensor.objectId, deviceName: sensor.deviceName, sensorName: sensor.sensorName, sensorType: sensor.sensorType },
      existingMapping,
      conflictReason,
    };

    const pending = pendingMappingStore.createMap({
      chatId: context.chatId,
      userId: context.userId,
      inventoryGeneration: inventory.generation,
      customerId: customer.id,
      prtgObjectId: objectId,
      expectedCustomer: { id: customer.id, clientId: customer.clientId, name: customer.name, enabled: customer.enabled, monitorType: customer.monitorType },
      expectedSensor: { objectId: sensor.objectId, deviceName: sensor.deviceName, sensorName: sensor.sensorName, sensorType: sensor.sensorType },
    });

    return { token: pending.id, preview };
  }

  confirmMapping(params: { clientId: string; objectId: number; operatorId: string; context: { userId: string; chatId: string; chatType: string }; token: string; inventory: InventorySnapshot }): PrtgMapping {
    const { clientId, objectId, operatorId, context, token, inventory } = params;

    // Check permission
    if (!accessService.canManageMappings(context)) {
      throw AppError.forbidden('Admin access required for mapping operations');
    }

    // Verify operator matches token owner
    if (operatorId !== context.userId) {
      throw AppError.forbidden('Operator mismatch');
    }

    // Get and validate pending WITHOUT consuming yet
    const pending = pendingMappingStore.get(token);
    if (!pending) {
      throw AppError.validation('Invalid or expired mapping session');
    }

    if (pending.action !== 'map') {
      throw AppError.validation('Invalid session type for mapping confirmation');
    }

    if (pending.chatId !== context.chatId) {
      throw AppError.validation('Session belongs to different chat');
    }

    if (pending.userId !== context.userId) {
      throw AppError.validation('Session belongs to different user');
    }

    // Verify objectId matches pending
    if (pending.prtgObjectId !== objectId) {
      throw AppError.validation('Object ID does not match pending session');
    }

    // Verify inventory generation hasn't changed
    if (pending.inventoryGeneration !== inventory.generation) {
      throw AppError.validation('Inventory has changed since preview; please re-run mapping preview');
    }

    // Reject stale inventory snapshot
    if (isInventoryStale(inventory)) {
      throw AppError.validation('Inventory is stale; please refresh before mapping');
    }

    // Re-verify customer and sensor
    const customer = customerService.getByClientId(clientId);
    if (!customer || customer.id !== pending.customerId) {
      throw AppError.validation('Customer no longer matches session');
    }

    if (!customer.enabled || customer.monitorType !== 'prtg') {
      throw AppError.validation('Customer no longer eligible for mapping');
    }

    // Verify customer fingerprint matches pending expectedCustomer
    if (
      customer.clientId !== pending.expectedCustomer.clientId ||
      customer.name !== pending.expectedCustomer.name ||
      customer.enabled !== pending.expectedCustomer.enabled ||
      customer.monitorType !== pending.expectedCustomer.monitorType
    ) {
      throw AppError.validation('Customer has changed since preview; please re-run mapping preview', { clientId });
    }

    // Find sensor in current inventory and verify identity
    const sensor = inventory.sensors.find(s => s.objectId === objectId);
    if (!sensor) {
      throw AppError.validation('Sensor not found in current inventory; please re-run mapping preview', { objectId });
    }

    // Verify sensor fingerprint matches pending expectedSensor
    if (
      sensor.sensorType.toLowerCase() !== 'ping' ||
      sensor.deviceName !== pending.expectedSensor.deviceName ||
      sensor.sensorName !== pending.expectedSensor.sensorName
    ) {
      throw AppError.validation('Sensor details have changed since preview; please re-run mapping preview', { objectId });
    }

    // Check for conflicts again
    const otherMapping = mappingRepository.findByPrtgObjectId(objectId);
    if (otherMapping && otherMapping.customerId !== customer.id) {
      throw AppError.validation('Sensor already mapped to another customer', { objectId });
    }

     // Check if customer already has mapping (allows human verification of AUTO mapping)
    const existing = mappingRepository.findByCustomerId(customer.id);
    if (existing) {
      if (existing.prtgObjectId === objectId) {
        if (existing.verified) {
          pendingMappingStore.consume(token);
          return existing;
        }
        const updated = mappingRepository.update(existing.id, {
          verified: true,
          mappingMethod: 'manual',
          mappedByTelegramId: operatorId,
        });
        if (!updated) {
          throw AppError.database('Failed to verify mapping');
        }
        pendingMappingStore.consume(token);
        return updated;
      }
      throw AppError.validation('Customer already has a mapping to a different sensor; use /unmap_client first', { clientId });
    }

    // All validations passed - perform write first, then consume token
    const result = mappingRepository.create({
      customerId: customer.id,
      prtgObjectId: objectId,
      prtgDeviceName: pending.expectedSensor.deviceName,
      prtgSensorName: pending.expectedSensor.sensorName,
      mappingMethod: 'manual',
      verified: true,
      mappedByTelegramId: operatorId,
    });

    // Consume token only after successful write
    const consumed = pendingMappingStore.consume(token);
    if (!consumed) {
      throw AppError.validation('Session was consumed by another request');
    }

    return result;
  }

  previewAutoMapping(context: { userId: string; chatId: string; chatType: string }, inventory: InventorySnapshot, clientId?: string): AutoMappingPreviewResult {
    if (!accessService.canManageMappings(context)) {
      throw AppError.forbidden('Admin access required for auto-mapping');
    }

    // Always evaluate against ALL eligible customers for conflict detection,
    // even when a single client_id is requested
    const allCustomers = customerService.listAll({ enabled: true, monitorType: 'prtg' });
    const filterCustomers = (clientId: string): Customer[] => {
      const customer = customerService.getByClientId(clientId);
      if (!customer) throw AppError.notFound('Customer not found', { clientId });
      return [customer];
    };

    const targetCustomers = clientId ? filterCustomers(clientId) : allCustomers;

    // Include ALL mappings (verified and unverified) for conflict detection
    const allMappings = mappingRepository.findAll();

    const automatic: AutoMappingPreview['automatic'] = [];
    const suggestions: AutoMappingPreview['suggestions'] = [];
    const unresolved: AutoMappingPreview['unresolved'] = [];

    // First pass: compute decisions for ALL eligible customers (needed for conflict detection)
    const decisions: Array<{
      customer: Customer;
      decision: ReturnType<typeof runMatcher>;
    }> = [];

    for (const customer of allCustomers) {
      if (mappingRepository.existsByCustomerId(customer.id)) {
        continue;
      }

      const decision = runMatcher({ customer, inventory: inventory.sensors, existingMappings: allMappings });
      decisions.push({ customer, decision });
    }

    // Track target sensors to detect shared-target conflicts across ALL customers
    // For single-customer preview, we still check all eligible customers for conflicts
    const targetSensors = new Map<number, Array<{ customerId: number; customer: Customer }>>();

    for (const { customer, decision } of decisions) {
      if (decision.kind === 'automatic') {
        const existing = targetSensors.get(decision.objectId);
        if (existing) {
          existing.push({ customerId: customer.id, customer });
        } else {
          targetSensors.set(decision.objectId, [{ customerId: customer.id, customer }]);
        }
      }
    }

    // Second pass: assign final categories, but only include target customers in output
    for (const { customer, decision } of decisions) {
      // When previewing a specific customer, skip other customers in output
      if (clientId && !targetCustomers.some(c => c.id === customer.id)) {
        continue;
      }

      if (decision.kind === 'automatic') {
        const candidates = targetSensors.get(decision.objectId) ?? [];
        if (candidates.length > 1) {
          // Shared-target conflict: all customers targeting this sensor become suggestions
          suggestions.push({
            customerId: customer.id,
            clientId: customer.clientId,
            name: customer.name,
            candidates: [{
              prtgObjectId: decision.objectId,
              deviceName: '',
              sensorName: '',
              sensorType: '',
              matchReason: 'Cross-customer conflict: sensor also targeted by another customer',
              confidence: 0.5,
            }],
          });
        } else {
          automatic.push({
            customerId: customer.id,
            clientId: customer.clientId,
            name: customer.name,
            objectId: decision.objectId,
            confidence: decision.confidence,
            reason: decision.reason,
          });
        }
      } else if (decision.kind === 'suggestions') {
        suggestions.push({
          customerId: customer.id,
          clientId: customer.clientId,
          name: customer.name,
          candidates: decision.candidates,
        });
      } else {
        unresolved.push({
          customerId: customer.id,
          clientId: customer.clientId,
          name: customer.name,
          reason: decision.reason,
        });
      }
    }

    const preview: AutoMappingPreview = { automatic, suggestions, unresolved };

    let token: string;
    if (automatic.length > 0) {
      const pending = pendingMappingStore.createAutoMap({
        chatId: context.chatId,
        userId: context.userId,
        inventoryGeneration: inventory.generation,
        decisions: automatic.map(d => ({
          customerId: d.customerId,
          objectId: d.objectId,
          confidence: d.confidence,
          reason: d.reason,
          // Store customer fingerprint for validation
          customerFingerprint: {
            clientId: customerService.getById(d.customerId)?.clientId || '',
            name: customerService.getById(d.customerId)?.name || '',
            enabled: customerService.getById(d.customerId)?.enabled || false,
            monitorType: customerService.getById(d.customerId)?.monitorType || '',
          },
        })),
      });
      token = pending.id;
    } else {
      const pending = pendingMappingStore.createAutoMap({
        chatId: context.chatId,
        userId: context.userId,
        inventoryGeneration: inventory.generation,
        decisions: [],
      });
      token = pending.id;
    }

    return { token, preview };
  }

  applyAutoMapping(context: { userId: string; chatId: string; chatType: string }, token: string, inventory: InventorySnapshot): PrtgMapping[] {
    if (!accessService.canManageMappings(context)) {
      throw AppError.forbidden('Admin access required for auto-mapping');
    }

    // Get pending WITHOUT consuming first
    const pending = pendingMappingStore.get(token);
    if (!pending) {
      throw AppError.validation('Invalid or expired auto-mapping session');
    }

    if (pending.action !== 'auto_map') {
      throw AppError.validation('Invalid session type for auto-mapping');
    }

    if (pending.chatId !== context.chatId) {
      throw AppError.validation('Session belongs to different chat');
    }

    if (pending.userId !== context.userId) {
      throw AppError.validation('Session belongs to different user');
    }

    // Verify inventory generation
    if (pending.inventoryGeneration !== inventory.generation) {
      throw AppError.validation('Inventory has changed since preview; please re-run auto-mapping preview');
    }

    // Reject stale inventory snapshot
    if (isInventoryStale(inventory)) {
      throw AppError.validation('Inventory is stale; please refresh before applying auto-mapping');
    }

    // Pre-validate all decisions before any writes
    const inputs: Array<{
      customerId: number;
      objectId: number;
      deviceName: string;
      sensorName: string;
      confidence: number;
    }> = [];

    for (const decision of pending.decisions) {
      const customer = customerService.getById(decision.customerId);
      if (!customer || !customer.enabled || customer.monitorType !== 'prtg') {
        throw AppError.validation('Customer no longer eligible for auto-mapping', { customerId: decision.customerId });
      }

      // Validate customer fingerprint
      if (decision.customerFingerprint) {
        const fp = decision.customerFingerprint;
        if (customer.clientId !== fp.clientId || customer.name !== fp.name || customer.enabled !== fp.enabled || customer.monitorType !== fp.monitorType) {
          throw AppError.validation('Customer has changed since preview; please re-run auto-mapping preview', { customerId: decision.customerId });
        }
      }

      // Re-check conflicts
      const otherMapping = mappingRepository.findByPrtgObjectId(decision.objectId);
      if (otherMapping && otherMapping.customerId !== decision.customerId) {
        throw AppError.validation('Sensor is now claimed by another customer; please re-run auto-mapping preview', { objectId: decision.objectId });
      }

      if (mappingRepository.existsByCustomerId(decision.customerId)) {
        throw AppError.validation('Customer already has a mapping; please re-run auto-mapping preview', { customerId: decision.customerId });
      }

      const sensor = inventory.sensors.find(s => s.objectId === decision.objectId);
      if (!sensor) {
        throw AppError.validation('Sensor not found in current inventory; please re-run auto-mapping preview', { objectId: decision.objectId });
      }

      inputs.push({
        customerId: decision.customerId,
        objectId: decision.objectId,
        deviceName: sensor.deviceName,
        sensorName: sensor.sensorName,
        confidence: decision.confidence,
      });
    }

    if (inputs.length === 0) {
      // No valid inputs - do NOT consume token; allow user to retry with different preview
      return [];
    }

    // Re-validate ownership right before write (prevents race with token consumption)
    const revalidatePending = pendingMappingStore.get(token);
    if (!revalidatePending) {
      throw AppError.validation('Session was consumed by another request');
    }

    // Create all mappings in a single transaction — consume token only AFTER success
    const createInputs = inputs.map(input => ({
      customerId: input.customerId,
      prtgObjectId: input.objectId,
      prtgDeviceName: input.deviceName,
      prtgSensorName: input.sensorName,
      mappingMethod: 'auto' as const,
      confidence: input.confidence,
      verified: false,
      mappedByTelegramId: context.userId,
    }));

    const created = mappingRepository.createInTransaction(createInputs);

    // Consume token only after successful transaction commit
    pendingMappingStore.consume(token);
    logger.info({ count: created.length, operatorId: context.userId }, 'Auto-mapping applied via transaction');
    return created;
  }

  prepareUnmap(clientId: string, context: { userId: string; chatId: string; chatType: string }): { token: string; preview: { customer: { id: number; clientId: string; name: string }; mapping: PrtgMapping } } {
    if (!accessService.canManageMappings(context)) {
      throw AppError.forbidden('Admin access required for unmap operations');
    }

    const customer = customerService.getByClientId(clientId);
    if (!customer) {
      throw AppError.notFound('Customer not found', { clientId });
    }

    const mapping = mappingRepository.findByCustomerId(customer.id);
    if (!mapping) {
      throw AppError.notFound('Customer has no mapping to remove', { clientId });
    }

    const pending = pendingMappingStore.createUnmap({
      chatId: context.chatId,
      userId: context.userId,
      inventoryGeneration: 0,
      customerId: customer.id,
      mappingId: mapping.id,
      expectedMapping: {
        customerId: mapping.customerId,
        prtgObjectId: mapping.prtgObjectId,
        mappingMethod: mapping.mappingMethod,
        verified: mapping.verified,
      },
    });

    return {
      token: pending.id,
      preview: {
        customer: { id: customer.id, clientId: customer.clientId, name: customer.name },
        mapping,
      },
    };
  }

  confirmUnmap(params: { context: { userId: string; chatId: string; chatType: string }; token: string }): boolean {
    const { context, token } = params;

    if (!accessService.canManageMappings(context)) {
      throw AppError.forbidden('Admin access required for unmap operations');
    }

    // Get and validate pending WITHOUT consuming yet
    const pending = pendingMappingStore.get(token);
    if (!pending) {
      throw AppError.validation('Invalid or expired unmap session');
    }

    if (pending.action !== 'unmap') {
      throw AppError.validation('Invalid session type for unmap confirmation');
    }

    if (pending.chatId !== context.chatId) {
      throw AppError.validation('Session belongs to different chat');
    }

    if (pending.userId !== context.userId) {
      throw AppError.validation('Session belongs to different user');
    }

    // Verify expected mapping still exists and matches
    const mapping = mappingRepository.findById(pending.mappingId);
    if (!mapping) {
      throw AppError.notFound('Mapping no longer exists');
    }

    if (mapping.customerId !== pending.expectedMapping.customerId ||
        mapping.prtgObjectId !== pending.expectedMapping.prtgObjectId ||
        mapping.mappingMethod !== pending.expectedMapping.mappingMethod ||
        mapping.verified !== pending.expectedMapping.verified) {
      throw AppError.validation('Mapping has changed; unmap cancelled for safety');
    }

     // All validations passed - perform write first, then consume token
    const deleted = mappingRepository.deleteById(mapping.id);
    if (!deleted) {
      throw AppError.database('Failed to delete mapping');
    }

    pendingMappingStore.consume(token);
    return true;
  }
}

import type { PrtgObjectCandidate } from '@/integrations/prtg/prtg.types';

export const mappingService = new MappingService();