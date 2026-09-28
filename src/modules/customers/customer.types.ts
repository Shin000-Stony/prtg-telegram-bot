import type { MonitorType } from '../../config/constants';
import type { PaginatedResult } from '../../core/types';

export interface Customer {
  id: number;
  clientId: string;
  name: string;
  monitorType: MonitorType;
  pingHost: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomerInput {
  clientId: string;
  name: string;
  monitorType: MonitorType;
  pingHost?: string | null;
  enabled?: boolean;
}

export interface UpdateCustomerInput {
  name?: string;
  monitorType?: MonitorType;
  pingHost?: string | null;
  enabled?: boolean;
}

export interface CustomerFilters {
  enabled?: boolean;
  monitorType?: MonitorType;
  search?: string;
  page?: number;
  pageSize?: number;
}

export type CustomerListResult = PaginatedResult<Customer>;