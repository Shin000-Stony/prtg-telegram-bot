import { groupRepository } from './group.repository';
import { getConfig } from '../../config/env';
import type { CustomerAccessScope } from './group.types';

export interface AccessContext {
  userId: string;
  chatId: string;
  chatType: string;
}

export class AccessService {
  isAdmin(userId: string): boolean {
    const config = getConfig();
    return config.TELEGRAM_ADMIN_IDS.includes(userId);
  }

  isPrivateChat(chatType: string): boolean {
    return chatType === 'private';
  }

  isGroupChat(chatType: string): boolean {
    return chatType === 'group' || chatType === 'supergroup';
  }

  isGlobalGroup(chatId: string): boolean {
    const config = getConfig();
    if (!config.TELEGRAM_GLOBAL_GROUP_ID) {
      return false;
    }
    return chatId === config.TELEGRAM_GLOBAL_GROUP_ID;
  }

  canManageCustomers(context: AccessContext): boolean {
    if (this.isAdmin(context.userId)) {
      if (this.isPrivateChat(context.chatType)) {
        return true;
      }
      if (this.isGlobalGroup(context.chatId)) {
        return true;
      }
    }
    return false;
  }

  canManageMappings(context: AccessContext): boolean {
    return this.canManageCustomers(context);
  }

  canViewCustomer(context: AccessContext, customerId: number): boolean {
    const scope = this.getCustomerAccessScope(context);
    if (scope.kind === 'all') {
      return true;
    }
    if (scope.kind === 'none') {
      return false;
    }
    // assigned scope
    return scope.customerIds.includes(customerId);
  }

  canReceiveAlerts(context: AccessContext, customerId: number): boolean {
    // Subscription depends on explicit receive_alerts, not admin status
    if (this.isGlobalGroup(context.chatId)) {
      const access = groupRepository.getAccess(context.chatId, customerId);
      return access?.receiveAlerts === true;
    }
    if (this.isPrivateChat(context.chatType)) {
      return false;
    }
    if (!this.isGroupRegistered(context.chatId)) {
      return false;
    }
    const access = groupRepository.getAccess(context.chatId, customerId);
    return access?.receiveAlerts === true;
  }

  isGroupRegistered(chatId: string): boolean {
    const group = groupRepository.findByChatId(chatId);
    return group !== null && group.enabled === true;
  }

  getCustomerAccessScope(context: AccessContext): CustomerAccessScope {
    // Private chat: only admin gets all
    if (this.isPrivateChat(context.chatType)) {
      if (this.isAdmin(context.userId)) {
        return { kind: 'all' };
      }
      return { kind: 'none' };
    }
    
    // Global Group: all for both admin and non-admin
    if (this.isGlobalGroup(context.chatId)) {
      return { kind: 'all' };
    }
    
    // Ordinary group: check registration
    if (!this.isGroupRegistered(context.chatId)) {
      return { kind: 'none' };
    }
    
    // Registered ordinary group: assigned customers only (for both admin and non-admin)
    const customerIds = groupRepository.getCustomerIdsWithAccess(context.chatId, false);
    return { kind: 'assigned', customerIds };
  }

  getVisibleCustomerIds(chatId: string): number[] {
    const config = getConfig();
    if (chatId === config.TELEGRAM_GLOBAL_GROUP_ID) {
      return [];
    }
    return groupRepository.getCustomerIdsWithAccess(chatId, false);
  }

  getAlertCustomerIds(chatId: string): number[] {
    const config = getConfig();
    if (chatId === config.TELEGRAM_GLOBAL_GROUP_ID) {
      return groupRepository.getCustomerIdsWithAccess(chatId, true);
    }
    return groupRepository.getCustomerIdsWithAccess(chatId, true);
  }

  canUnregisterGroup(context: AccessContext): boolean {
    // Only configured bot admin can unregister ordinary registered groups
    if (!this.isAdmin(context.userId)) {
      return false;
    }
    if (this.isPrivateChat(context.chatType)) {
      return false; // unregister only works in groups
    }
    if (this.isGlobalGroup(context.chatId)) {
      return false; // Global Group cannot be unregistered
    }
    // Must be a registered and enabled ordinary group
    return this.isGroupRegistered(context.chatId);
  }
}

export const accessService = new AccessService();