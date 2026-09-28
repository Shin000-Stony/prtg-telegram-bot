import { groupRepository } from './group.repository';
import type { TelegramGroup, GroupFilters, GroupListResult, AssignCustomerInput, GroupCustomerAccess } from './group.types';
import { getLogger } from '../../core/logger';

export class GroupService {
  private logger = getLogger().child({ module: 'GroupService' });

  register(chatId: string, title: string | null): TelegramGroup {
    this.logger.info({ chatId }, 'Registering group');
    
    // Check if group already exists
    const existing = groupRepository.findByChatId(chatId);
    if (existing) {
      // Group already exists, update title if provided
      if (title !== null && existing.title !== title) {
        return groupRepository.upsert(chatId, title);
      }
      return existing;
    }
    
    // New group registration
    return groupRepository.upsert(chatId, title);
  }
  // ... rest of the file

  getByChatId(chatId: string): TelegramGroup | null {
    return groupRepository.findByChatId(chatId);
  }

  list(filters: GroupFilters = {}): GroupListResult {
    return groupRepository.findAll(filters);
  }

  setEnabled(chatId: string, enabled: boolean): boolean {
    this.logger.info({ chatId, enabled }, 'Setting group enabled status');
    return groupRepository.setEnabled(chatId, enabled);
  }

  assignCustomer(input: AssignCustomerInput): GroupCustomerAccess {
    this.logger.info({ groupChatId: input.groupChatId, customerId: input.customerId }, 'Assigning customer to group');
    return groupRepository.assignCustomer(input);
  }

  unassignCustomer(groupChatId: string, customerId: number): { canView: boolean; receiveAlerts: boolean } {
    this.logger.info({ groupChatId, customerId }, 'Unassigning customer from group');
    const access = groupRepository.getAccess(groupChatId, customerId);
    if (!access) {
      return { canView: false, receiveAlerts: false };
    }

    if (access.canView === false && access.receiveAlerts === false) {
      groupRepository.removeAccess(groupChatId, customerId);
      return { canView: false, receiveAlerts: false };
    }

    if (access.canView === true && access.receiveAlerts === false) {
      groupRepository.removeAccess(groupChatId, customerId);
      return { canView: false, receiveAlerts: false };
    }

    // Preserve receive_alerts when unassigning
    const updated = groupRepository.updateAccess(groupChatId, customerId, { canView: false });
    return updated ? { canView: updated.canView, receiveAlerts: updated.receiveAlerts } : { canView: false, receiveAlerts: access.receiveAlerts };
  }

  setAlertSubscription(groupChatId: string, customerId: number, receiveAlerts: boolean): GroupCustomerAccess {
    this.logger.info({ groupChatId, customerId, receiveAlerts }, 'Setting alert subscription');
    return groupRepository.setAlertSubscription({ groupChatId, customerId, receiveAlerts });
  }

  getAccess(groupChatId: string, customerId: number): GroupCustomerAccess | null {
    return groupRepository.getAccess(groupChatId, customerId);
  }

  getGroupWithCustomerDetails(groupChatId: string): Array<{ customerId: number; clientId: string; name: string; monitorType: string; canView: boolean; receiveAlerts: boolean }> {
    return groupRepository.getGroupWithCustomerDetails(groupChatId);
  }

  unregisterGroup(chatId: string): boolean {
    this.logger.info({ chatId }, 'Unregistering group');
    return groupRepository.removeGroup(chatId);
  }

  getGroupWithAlertDetails(groupChatId: string): Array<{ customerId: number; clientId: string; name: string; monitorType: string; receiveAlerts: boolean }> {
    const rows = groupRepository.getGroupWithCustomerDetails(groupChatId);
    return rows.filter(r => r.receiveAlerts).map(r => ({
      customerId: r.customerId,
      clientId: r.clientId,
      name: r.name,
      monitorType: r.monitorType,
      receiveAlerts: r.receiveAlerts,
    }));
  }
}

export const groupService = new GroupService();