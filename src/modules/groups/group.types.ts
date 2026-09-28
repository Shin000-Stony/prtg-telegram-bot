import type { PaginatedResult } from '../../core/types';

export interface TelegramGroup {
  chatId: string;
  title: string | null;
  enabled: boolean;
  registeredAt: string;
}

export interface GroupFilters {
  enabled?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export type GroupListResult = PaginatedResult<TelegramGroup>;

export interface GroupCustomerAccess {
  groupChatId: string;
  customerId: number;
  canView: boolean;
  receiveAlerts: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssignCustomerInput {
  groupChatId: string;
  customerId: number;
  canView?: boolean;
  receiveAlerts?: boolean;
}

export interface UpdateAccessInput {
  canView?: boolean;
  receiveAlerts?: boolean;
}

export interface SetAlertInput {
  groupChatId: string;
  customerId: number;
  receiveAlerts: boolean;
}

export type CustomerAccessScope =
  | { kind: 'all' }
  | { kind: 'assigned'; customerIds: number[] }
  | { kind: 'none' };