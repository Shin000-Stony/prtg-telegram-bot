import { customerRepository } from './customer.repository';
import { validateCreateCustomer, validateUpdateCustomer, validateCustomerFilters } from './customer.validators';
import type { Customer, CreateCustomerInput, CustomerListResult } from './customer.types';
import { AppError } from '../../core/errors/app-error';
import { getLogger } from '../../core/logger';
import { ZodError } from 'zod';

export class CustomerService {
  private logger = getLogger().child({ module: 'CustomerService' });

  private handleZodError(error: unknown, _context: string): never {
    if (error instanceof ZodError) {
      const messages = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw AppError.validation(messages, { zodErrors: error.errors });
    }
    throw error;
  }

  create(input: unknown): Customer {
    let validated: CreateCustomerInput;
    try {
      validated = validateCreateCustomer(input);
    } catch (error) {
      this.handleZodError(error, 'create');
    }

    this.logger.info({ clientId: validated.clientId }, 'Creating customer');

    if (customerRepository.findByClientId(validated.clientId)) {
      throw AppError.validation('Client ID already exists', { clientId: validated.clientId });
    }

    return customerRepository.create(validated);
  }

  getById(id: number): Customer | null {
    return customerRepository.findById(id);
  }

  getByClientId(clientId: string): Customer | null {
    return customerRepository.findByClientId(clientId);
  }

  list(filters: unknown = {}): CustomerListResult {
    let validated: ReturnType<typeof validateCustomerFilters>;
    try {
      validated = validateCustomerFilters(filters);
    } catch (error) {
      this.handleZodError(error, 'list');
    }
    return customerRepository.findAll(validated);
  }

  listAll(filters: unknown = {}): Customer[] {
    let validated: ReturnType<typeof validateCustomerFilters>;
    try {
      validated = validateCustomerFilters(filters);
    } catch (error) {
      this.handleZodError(error, 'listAll');
    }
    return customerRepository.findAllUnpaged(validated);
  }

  update(id: number, input: unknown): Customer {
    let validated: ReturnType<typeof validateUpdateCustomer>;
    try {
      validated = validateUpdateCustomer(input);
    } catch (error) {
      this.handleZodError(error, 'update');
    }

    this.logger.info({ id }, 'Updating customer');

    const existing = customerRepository.findById(id);
    if (!existing) {
      throw AppError.notFound('Customer not found', { id });
    }

    const updated = customerRepository.update(id, validated);
    if (!updated) {
      throw AppError.internal('Failed to update customer', { id });
    }

    return updated;
  }

  delete(id: number): boolean {
    this.logger.info({ id }, 'Deleting customer');
    return customerRepository.delete(id);
  }

  bulkCreate(inputs: unknown[]): Customer[] {
    const validated = inputs.map((input) => {
      try {
        return validateCreateCustomer(input);
      } catch (error) {
        this.handleZodError(error, 'bulkCreate');
      }
    });

    this.logger.info({ count: validated.length }, 'Bulk creating customers');

    const batchClientIds = new Set<string>();
    for (const c of validated) {
      if (batchClientIds.has(c.clientId)) {
        throw AppError.validation('Duplicate client IDs in batch', { duplicates: [c.clientId] });
      }
      batchClientIds.add(c.clientId);
    }

    const existingIds = new Set(
      validated.map((c) => c.clientId).filter((id) => customerRepository.findByClientId(id))
    );

    if (existingIds.size > 0) {
      throw AppError.validation('Duplicate client IDs found', { duplicates: Array.from(existingIds) });
    }

    return customerRepository.bulkCreate(validated);
  }

  getStats(): { total: number; byMonitorType: Record<string, number> } {
    return {
      total: customerRepository.count(),
      byMonitorType: customerRepository.countByMonitorType(),
    };
  }
}

export const customerService = new CustomerService();