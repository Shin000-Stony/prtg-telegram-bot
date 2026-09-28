import { z } from 'zod';
import type { MonitorType } from '../../config/constants';
import { MONITOR_TYPES } from '../../config/constants';

export const clientIdSchema = z.string().min(1, 'Client ID is required').max(50).transform((v) => v.trim());
export const customerNameSchema = z.string().min(1, 'Name is required').max(200).transform((v) => v.trim());
export const pingHostSchema = z.string().max(255).nullable().optional().transform((v) => (v === '' ? null : v?.trim() ?? null));

export const monitorTypeSchema = z.enum(MONITOR_TYPES);

export const createCustomerSchema = z.object({
  clientId: clientIdSchema,
  name: customerNameSchema,
  monitorType: monitorTypeSchema,
  pingHost: pingHostSchema,
  enabled: z.boolean().optional(),
}).refine((data) => {
  if (data.monitorType === 'icmp' && !data.pingHost) {
    return false;
  }
  return true;
}, {
  message: 'ping_host is required for ICMP monitor type',
  path: ['pingHost'],
});

export const updateCustomerSchema = z.object({
  name: customerNameSchema.optional(),
  monitorType: monitorTypeSchema.optional(),
  pingHost: pingHostSchema,
  enabled: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: 'At least one field must be provided',
}).refine((data) => {
  if (data.monitorType === 'icmp' && !data.pingHost) {
    return false;
  }
  return true;
}, {
  message: 'ping_host is required for ICMP monitor type',
  path: ['pingHost'],
});

export const customerFiltersSchema = z.object({
  enabled: z.boolean().optional(),
  monitorType: monitorTypeSchema.optional(),
  search: z.string().max(100).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(20),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CustomerFilters = z.infer<typeof customerFiltersSchema>;

export function validateCreateCustomer(input: unknown): CreateCustomerInput {
  return createCustomerSchema.parse(input);
}

export function validateUpdateCustomer(input: unknown): UpdateCustomerInput {
  return updateCustomerSchema.parse(input);
}

export function validateCustomerFilters(input: unknown): CustomerFilters {
  return customerFiltersSchema.parse(input);
}

export function validateMonitorType(value: string): MonitorType {
  return monitorTypeSchema.parse(value);
}