import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting, getDatabase } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { groupAlertsCommand } from '@/integrations/telegram/commands/group-alerts.command';
import { parseGroupAlertsCallback } from '@/integrations/telegram/ui/cards';
import {
  handleGroupAlertsToggle,
  handleGroupAlertsPage,
  handleGroupAlertsBulk,
  handleGroupAlertsBulkConfirm,
  handleGroupAlertsBulkCancel,
  handleGroupAlertsClose,
} from '@/integrations/telegram/handlers/group-alerts-callbacks';
import { groupAlertsStore } from '@/modules/groups/group-alerts.store';
import { accessService } from '@/modules/groups/access.service';
import { groupService } from '@/modules/groups/group.service';
import { groupRepository } from '@/modules/groups/group.repository';
import { customerService } from '@/modules/customers/customer.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GLOBAL_GROUP_ID = '-1001234567890';
const ADMIN_USER_ID = '123456789';
const ORDINARY_GROUP_ID = '-100111111900';
const CALLBACK_MESSAGE_ID = 100;

interface MockCustomer {
  customerId: number;
  clientId: string;
  name: string;
  monitorType: string;
  canView: boolean;
  enabled: boolean;
  receiveAlerts: boolean;
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function extractPreviewIdFromKeyboard(keyboard: { inline_keyboard: Array<Array<{ callback_data: string }>> }): string | null {
  const confirmButton = keyboard.inline_keyboard[0][0];
  const parts = confirmButton.callback_data.split(':');
  return parts[2] || null;
}

describe('/group_alerts interactive menu', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-gam-'));
    testDbPath = join(testDir, 'test.db');
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', ADMIN_USER_ID);
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', GLOBAL_GROUP_ID);
    vi.stubEnv('DATABASE_PATH', testDbPath);
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    resetMigrationsForTesting();
    runMigrations();
  });

  afterEach(async () => {
    groupAlertsStore.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetConfigForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  function makeContext(overrides: {
    userId: string;
    chatId: string;
    chatType: string;
    messageText?: string;
    callbackQueryData?: string;
    fromId?: string;
  }) {
    const reply = vi.fn().mockResolvedValue({ message_id: 999 });
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const answerCbQuery = vi.fn().mockResolvedValue(undefined);
    const ctx: any = {
      userId: overrides.userId,
      chatId: overrides.chatId,
      chatType: overrides.chatType,
      from: { id: BigInt(overrides.fromId || overrides.userId) },
      reply,
      editMessageText,
      answerCbQuery,
    };
    if (overrides.messageText) {
      ctx.message = { text: overrides.messageText };
    }
    if (overrides.callbackQueryData) {
      ctx.callbackQuery = {
        data: overrides.callbackQueryData,
        id: 'query1',
        from: { id: BigInt(overrides.fromId || overrides.userId) },
        message: { message_id: CALLBACK_MESSAGE_ID },
      };
    }
    return ctx;
  }

  function createCustomerWithAccess(clientId: string, name: string, receiveAlerts: boolean, enabled: boolean = true): any {
    const customer = customerService.create({ clientId, name, monitorType: 'prtg', pingHost: null, enabled });
    groupRepository.setAlertSubscription({ groupChatId: GLOBAL_GROUP_ID, customerId: customer.id, receiveAlerts });
    return customer;
  }

  function createCustomerForOrdinaryGroup(clientId: string, name: string, receiveAlerts: boolean, enabled: boolean = true): any {
    groupService.register(ORDINARY_GROUP_ID, 'Test Group');
    const customer = customerService.create({ clientId, name, monitorType: 'prtg', pingHost: null, enabled });
    groupRepository.assignCustomer({ groupChatId: ORDINARY_GROUP_ID, customerId: customer.id, canView: true, receiveAlerts });
    return customer;
  }

  function createSession(chatId: string, isGlobal: boolean, customers: MockCustomer[]): any {
    return groupAlertsStore.create({
      userId: ADMIN_USER_ID,
      chatId,
      messageId: CALLBACK_MESSAGE_ID,
      isGlobalGroup: isGlobal,
      customers,
    });
  }

  function toMockCustomer(c: any, receiveAlerts: boolean, canView: boolean = true): MockCustomer {
    return {
      customerId: c.id,
      clientId: c.clientId,
      name: c.name,
      monitorType: c.monitorType,
      canView,
      enabled: c.enabled,
      receiveAlerts,
    };
  }

  function extractPreviewAndConfirmData(session: any): { previewId: string; confirmData: string; cancelData: string } {
    const confirmKeyboard: any = ({} as any);
    const bulkCtx = makeContext({
      userId: ADMIN_USER_ID,
      chatId: session.chatId,
      chatType: 'supergroup',
    });
    return { previewId: '', confirmData: '', cancelData: '' };
  }

  function getPreviewIdFromSession(session: any): string {
    return session.currentPreview?.previewId || '';
  }

  // =====================================================================
  // COMMAND TESTS
  // =====================================================================
  describe('Command: no args opens interactive menu', () => {
    it('Global Group admin opens menu showing all customers including disabled', async () => {
      customerService.create({ clientId: 'GA-101', name: 'Enabled Client', monitorType: 'prtg', pingHost: null, enabled: true });
      customerService.create({ clientId: 'GA-102', name: 'Disabled Client', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: false });

      const ctx = makeContext({ userId: ADMIN_USER_ID, chatId: GLOBAL_GROUP_ID, chatType: 'supergroup', messageText: '/group_alerts' });
      await groupAlertsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalledTimes(1);
      const [text, opts] = ctx.reply.mock.calls[0];
      expect(text).toContain('GLOBAL GROUP');
      expect(text).toContain('GA-101');
      expect(text).toContain('GA-102');
      expect(text).toContain('disabled');
      expect(opts.reply_markup).toBeDefined();
      expect(opts.reply_markup.inline_keyboard.length).toBeGreaterThan(0);
    });

    it('Ordinary registered group admin opens menu showing assigned customers with can_view', async () => {
      const customer = createCustomerForOrdinaryGroup('GA-103', 'Assigned Client', false);
      const ctx = makeContext({ userId: ADMIN_USER_ID, chatId: ORDINARY_GROUP_ID, chatType: 'supergroup', messageText: '/group_alerts' });
      await groupAlertsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalledTimes(1);
      const [text] = ctx.reply.mock.calls[0];
      expect(text).toContain('GROUP ALERTS');
      expect(text).toContain('GA-103');
    });

    it('Private chat is rejected', async () => {
      const ctx = makeContext({ userId: ADMIN_USER_ID, chatId: ADMIN_USER_ID, chatType: 'private', messageText: '/group_alerts' });
      await groupAlertsCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('This command only works in groups'));
    });

    it('Non-admin is denied', async () => {
      const ctx = makeContext({ userId: '999999999', chatId: GLOBAL_GROUP_ID, chatType: 'supergroup', messageText: '/group_alerts', fromId: '999999999' });
      await groupAlertsCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    });

    it('Unregistered ordinary group is denied', async () => {
      const ctx = makeContext({ userId: ADMIN_USER_ID, chatId: '-100111111999', chatType: 'supergroup', messageText: '/group_alerts' });
      await groupAlertsCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('not registered'));
    });

    it('Missing chatType is rejected', async () => {
      const ctx = makeContext({ userId: ADMIN_USER_ID, chatId: GLOBAL_GROUP_ID, chatType: '', messageText: '/group_alerts' });
      await groupAlertsCommand(ctx);
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  describe('Command: with args preserves existing behavior', () => {
    it('Global Group + client_id on enables alerts', async () => {
      const customer = customerService.create({ clientId: 'GA-104', name: 'Test Client', monitorType: 'prtg', pingHost: null, enabled: true });
      const ctx = makeContext({ userId: ADMIN_USER_ID, chatId: GLOBAL_GROUP_ID, chatType: 'supergroup', messageText: '/group_alerts GA-104 on' });
      await groupAlertsCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('enabled'));
    });

    it('Ordinary group + client_id off disables alerts', async () => {
      const customer = createCustomerForOrdinaryGroup('GA-105', 'Test Client', true);
      const ctx = makeContext({ userId: ADMIN_USER_ID, chatId: ORDINARY_GROUP_ID, chatType: 'supergroup', messageText: '/group_alerts GA-105 off' });
      await groupAlertsCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('disabled'));
    });

    it('Invalid action shows usage error', async () => {
      groupService.register(ORDINARY_GROUP_ID, 'Test Group');
      const ctx = makeContext({ userId: ADMIN_USER_ID, chatId: ORDINARY_GROUP_ID, chatType: 'supergroup', messageText: '/group_alerts GA-105 maybe' });
      await groupAlertsCommand(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Action must be'));
    });
  });

  // =====================================================================
  // TOGGLE TESTS
  // =====================================================================
  describe('Callback: toggle single customer alerts', () => {
    it('toggles alerts from OFF to ON with explicit target', async () => {
      const customer = createCustomerWithAccess('GA-106', 'Toggle Client', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(customer, false)]);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${customer.id}:on`,
      });
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalled();
      const callText = ctx.answerCbQuery.mock.calls[0][0];
      expect(callText).toMatch(/Alerts ON/i);
      expect(ctx.editMessageText).toHaveBeenCalled();

      const dbAccess = groupRepository.getAccess(GLOBAL_GROUP_ID, customer.id);
      expect(dbAccess!.receiveAlerts).toBe(true);
    });

    it('toggles alerts from ON to OFF with explicit target', async () => {
      const customer = createCustomerWithAccess('GA-107', 'Toggle Client', true);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(customer, true)]);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${customer.id}:off`,
      });
      await handleGroupAlertsToggle(ctx);

      const dbAccess = groupRepository.getAccess(GLOBAL_GROUP_ID, customer.id);
      expect(dbAccess!.receiveAlerts).toBe(false);
    });

    it('repeated ON toggle when already ON keeps ON (no flip)', async () => {
      const customer = createCustomerWithAccess('GA-126', 'Toggle Client', true);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(customer, true)]);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${customer.id}:on`,
      });
      await handleGroupAlertsToggle(ctx);

      const dbAccess = groupRepository.getAccess(GLOBAL_GROUP_ID, customer.id);
      expect(dbAccess!.receiveAlerts).toBe(true);
    });

    it('different user is denied', async () => {
      const customer = createCustomerWithAccess('GA-108', 'Toggle Client', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(customer, false)]);

      const ctx = makeContext({
        userId: '999999999',
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${customer.id}:on`,
        fromId: '999999999',
      });
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('Unauthorized'));
    });

    it('different chat is denied', async () => {
      const customer = createCustomerWithAccess('GA-109', 'Toggle Client', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(customer, false)]);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: '-100111111999',
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${customer.id}:on`,
      });
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('This menu belongs to a different chat');
    });

    it('invalid toggle target is rejected', async () => {
      const customer = createCustomerWithAccess('GA-119', 'Toggle Client', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(customer, false)]);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${customer.id}:maybe`,
      });
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Invalid callback');
    });

    it('wrong messageId is rejected without editMessageText', async () => {
      const customer = createCustomerWithAccess('GA-120', 'Toggle Client', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(customer, false)]);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${customer.id}:on`,
      });
      ctx.callbackQuery.message.message_id = 999;
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Session message changed');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });

    it('missing message on callback is rejected without editMessageText', async () => {
      const customer = createCustomerWithAccess('GA-121', 'Toggle Client', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(customer, false)]);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${customer.id}:on`,
      });
      delete ctx.callbackQuery.message;
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Session message changed');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });

    it('null messageId in session is rejected without editMessageText', async () => {
      const customer = createCustomerWithAccess('GA-122', 'Toggle Client', false);
      const session = groupAlertsStore.create({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        messageId: null,
        isGlobalGroup: true,
        customers: [toMockCustomer(customer, false)],
      });

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${customer.id}:on`,
      });
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Session message ID missing');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });

    it('blocked while executing', async () => {
      const customer = createCustomerWithAccess('GA-123', 'Toggle Client', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(customer, false)]);
      session.state = 'executing';

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${customer.id}:on`,
      });
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('A bulk operation is in progress; finish it first');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });

    it('revoked can_view after menu open is rejected without DB change', async () => {
      groupService.register(ORDINARY_GROUP_ID, 'Test Group');
      const c1 = customerService.create({ clientId: 'GA-130', name: 'Toggle Client', monitorType: 'prtg', pingHost: null, enabled: true });
      groupRepository.assignCustomer({ groupChatId: ORDINARY_GROUP_ID, customerId: c1.id, canView: true, receiveAlerts: false });
      const session = createSession(ORDINARY_GROUP_ID, false, [toMockCustomer(c1, false, true)]);

      // Revoke can_view in DB after session creation
      groupRepository.getDb().prepare('UPDATE group_customer_access SET can_view = 0 WHERE group_chat_id = ? AND customer_id = ?').run(ORDINARY_GROUP_ID, c1.id);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: ORDINARY_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${c1.id}:on`,
      });
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('not in this view or visibility revoked'));
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // PAGINATION TESTS
  // =====================================================================
  describe('Callback: pagination', () => {
    it('navigates to next page', async () => {
      const customers: MockCustomer[] = [];
      for (let i = 0; i < 20; i++) {
        const c = customerService.create({ clientId: `P-${i}`, name: `Client ${i}`, monitorType: 'prtg', pingHost: null, enabled: true });
        groupRepository.setAlertSubscription({ groupChatId: GLOBAL_GROUP_ID, customerId: c.id, receiveAlerts: false });
        customers.push(toMockCustomer(c, false));
      }

      const session = createSession(GLOBAL_GROUP_ID, true, customers);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_page:${session.token}:2`,
      });
      await handleGroupAlertsPage(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalled();
      expect(ctx.editMessageText).toHaveBeenCalled();
    });

    it('invalid page is rejected', async () => {
      const session = createSession(GLOBAL_GROUP_ID, true, []);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_page:${session.token}:abc`,
      });
      await handleGroupAlertsPage(ctx);
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Invalid callback');
    });
  });

  // =====================================================================
  // BULK PREVIEW TESTS
  // =====================================================================
  describe('Callback: bulk enable all', () => {
    it('shows preview with affected customers', async () => {
      const c1 = createCustomerWithAccess('GA-110', 'Client A', false, true);
      const c2 = createCustomerWithAccess('GA-111', 'Client B', false, false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false), toMockCustomer(c2, false)]);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(ctx);

      expect(ctx.editMessageText).toHaveBeenCalled();
      const [text, opts] = ctx.editMessageText.mock.calls[0];
      expect(text).toContain('BULK ALERT ENABLE');
      expect(text).toContain('Affected : 2');
      expect(opts.reply_markup).toBeDefined();
      expect(opts.reply_markup.inline_keyboard[0][0].text).toContain('Confirm');
      expect(opts.reply_markup.inline_keyboard[0][1].text).toContain('Cancel');

      expect(session.state).toBe('pending');
      expect(session.currentPreview).toBeDefined();
      expect(session.currentPreview!.action).toBe('enable_all');
      expect(session.currentPreview!.targetIds).toEqual(expect.arrayContaining([c1.id, c2.id]));
      expect(session.currentPreview!.affectedIds).toEqual(expect.arrayContaining([c1.id, c2.id]));
    });

    it('no affected customers when all already enabled', async () => {
      const c1 = createCustomerWithAccess('GA-112', 'Client A', true);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, true)]);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('All alerts are already ON');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
      expect(session.state).toBe('idle');
    });

    it('confirm callback data uses ga_confirm prefix and includes previewId', async () => {
      const c1 = createCustomerWithAccess('GA-122', 'Client A', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false)]);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(ctx);

      const keyboard = ctx.editMessageText.mock.calls[0][1].reply_markup;
      const confirmData = keyboard.inline_keyboard[0][0].callback_data;
      const cancelData = keyboard.inline_keyboard[0][1].callback_data;
      expect(confirmData).toMatch(/^ga_confirm:.+:.+$/);
      expect(cancelData).toMatch(/^ga_cancel:.+:.+$/);
      expect(confirmData.split(':')[2]).toBe(session.currentPreview!.previewId);
      expect(Buffer.byteLength(confirmData, 'utf8')).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(cancelData, 'utf8')).toBeLessThanOrEqual(64);
    });
  });

  // =====================================================================
  // BULK CONFIRM TESTS
  // =====================================================================
  describe('Callback: bulk confirm', () => {
    it('applies enable all and re-renders menu', async () => {
      const c1 = createCustomerWithAccess('GA-113', 'Client A', false);
      const c2 = createCustomerWithAccess('GA-114', 'Client B', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false), toMockCustomer(c2, false)]);

      // Show bulk preview
      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      const previewId = getPreviewIdFromSession(session);

      // Confirm
      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(ctx);

      expect(ctx.editMessageText).toHaveBeenCalled();
      const lastCall = ctx.editMessageText.mock.calls[ctx.editMessageText.mock.calls.length - 1];
      const [lastText] = lastCall;
      expect(lastText).toContain('Alerts: ON');

      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c1.id)!.receiveAlerts).toBe(true);
      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c2.id)!.receiveAlerts).toBe(true);

      expect(session.state).toBe('idle');
      expect(session.currentPreview).toBeNull();
    });

    it('preview identity mismatch is rejected', async () => {
      const session = createSession(GLOBAL_GROUP_ID, true, []);

      // Manually set a preview
      const previewId = groupAlertsStore.generatePreviewId();
      session.state = 'pending';
      session.currentPreview = {
        previewId,
        action: 'enable_all',
        targetIds: [1],
        affectedIds: [1],
        createdAt: new Date(),
      };

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:wrong_preview_id`,
      });
      await handleGroupAlertsBulkConfirm(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Preview expired or invalid');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });

    it('different user cannot confirm bulk action', async () => {
      const c1 = createCustomerWithAccess('GA-115', 'Client A', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false)]);

      // Show bulk preview
      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      const previewId = getPreviewIdFromSession(session);

      const ctx = makeContext({
        userId: '999999999',
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
        fromId: '999999999',
      });
      await handleGroupAlertsBulkConfirm(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('Unauthorized'));
    });

    it('expired session is rejected', async () => {
      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: 'ga_confirm:expired_token:preview123',
      });
      await handleGroupAlertsBulkConfirm(ctx);
      expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('expired'));
    });

    it('old preview does not affect new preview', async () => {
      const c1 = createCustomerWithAccess('GA-140', 'Client A', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false)]);

      // First bulk preview
      const bulkCtx1 = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx1);
      const previewId1 = getPreviewIdFromSession(session);

      // Cancel first preview
      const cancelCtx1 = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_cancel:${session.token}:${previewId1}`,
      });
      await handleGroupAlertsBulkCancel(cancelCtx1);

       // Second bulk preview (customer still OFF since first was cancelled)
      const bulkCtx2 = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx2);
      const previewId2 = getPreviewIdFromSession(session);

      // Confirm with old previewId should fail
      const staleCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId1}`,
      });
      await handleGroupAlertsBulkConfirm(staleCtx);

      expect(staleCtx.answerCbQuery).toHaveBeenCalledWith('Preview expired or invalid');

      // Confirm with new previewId should succeed
      const validCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId2}`,
      });
      await handleGroupAlertsBulkConfirm(validCtx);

      expect(validCtx.editMessageText).toHaveBeenCalled();
    });
  });

  // =====================================================================
  // BULK CANCEL TESTS
  // =====================================================================
  describe('Callback: bulk cancel', () => {
    it('cancels bulk action and returns to menu', async () => {
      const c1 = createCustomerWithAccess('GA-116', 'Client A', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false)]);

      // Show bulk preview
      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      const previewId = getPreviewIdFromSession(session);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_cancel:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkCancel(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Cancelled');
      expect(ctx.editMessageText).toHaveBeenCalled();
      expect(session.state).toBe('idle');
      expect(session.currentPreview).toBeNull();
    });

    it('preview identity mismatch on cancel is rejected', async () => {
      const session = createSession(GLOBAL_GROUP_ID, true, []);

      const previewId = groupAlertsStore.generatePreviewId();
      session.state = 'pending';
      session.currentPreview = {
        previewId,
        action: 'enable_all',
        targetIds: [],
        affectedIds: [],
        createdAt: new Date(),
      };

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_cancel:${session.token}:wrong_preview_id`,
      });
      await handleGroupAlertsBulkCancel(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Preview expired or invalid');
    });

    it('cancel during executing state is rejected', async () => {
      const session = createSession(GLOBAL_GROUP_ID, true, []);
      const previewId = groupAlertsStore.generatePreviewId();
      session.state = 'executing';
      session.currentPreview = {
        previewId,
        action: 'enable_all',
        targetIds: [],
        affectedIds: [],
        createdAt: new Date(),
      };

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_cancel:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkCancel(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('No pending bulk action to cancel');
    });
  });

  // =====================================================================
  // CLOSE TESTS
  // =====================================================================
  describe('Callback: close menu', () => {
    it('closes the menu and deletes session', async () => {
      const session = createSession(GLOBAL_GROUP_ID, true, []);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_close:${session.token}`,
      });
      await handleGroupAlertsClose(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Closed');
      expect(ctx.editMessageText).toHaveBeenCalledWith('❌ Alert subscription menu closed.');
      expect(groupAlertsStore.get(session.token)).toBeUndefined();
    });

    it('different user cannot close another user menu', async () => {
      const session = createSession(GLOBAL_GROUP_ID, true, []);

      const ctx = makeContext({
        userId: '999999999',
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_close:${session.token}`,
        fromId: '999999999',
      });
      await handleGroupAlertsClose(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('Unauthorized'));
      expect(ctx.editMessageText).not.toHaveBeenCalled();
      expect(groupAlertsStore.get(session.token)).toBeDefined();
    });

    it('close during executing is rejected', async () => {
      const session = createSession(GLOBAL_GROUP_ID, true, []);
      session.state = 'executing';

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_close:${session.token}`,
      });
      await handleGroupAlertsClose(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('A bulk operation is in progress; finish it first');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // BULK DISABLE ALL TESTS
  // =====================================================================
  describe('Bulk disable all', () => {
    it('shows preview and applies disable for customers with alerts ON', async () => {
      const c1 = createCustomerWithAccess('GA-117', 'Client A', true);
      const c2 = createCustomerWithAccess('GA-118', 'Client B', true);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, true), toMockCustomer(c2, true)]);

      // Show preview
      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:disable_all`,
      });
      await handleGroupAlertsBulk(ctx);

      expect(ctx.editMessageText).toHaveBeenCalled();
      const [text] = ctx.editMessageText.mock.calls[0];
      expect(text).toContain('BULK ALERT DISABLE');
      expect(text).toContain('Affected : 2');

      const previewId = getPreviewIdFromSession(session);

      // Confirm
      const ctx2 = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(ctx2);

      expect(ctx2.editMessageText).toHaveBeenCalled();
      const resultCall = ctx2.editMessageText.mock.calls.find(call => call[0].includes('DISABLED'));
      expect(resultCall).toBeDefined();
      expect(resultCall![0]).toContain('Updated 2 customer(s)');

      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c1.id)!.receiveAlerts).toBe(false);
      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c2.id)!.receiveAlerts).toBe(false);
    });
  });

  // =====================================================================
  // CONCURRENCY TESTS (A)
  // =====================================================================
  describe('Concurrency', () => {
    it('concurrent confirm is rejected when first is executing', async () => {
      const c1 = createCustomerWithAccess('GA-150', 'Client A', false);
      const c2 = createCustomerWithAccess('GA-151', 'Client B', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false), toMockCustomer(c2, false)]);

      // Show bulk preview
      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      const previewId = getPreviewIdFromSession(session);

      // Spy on bulkSetAlertSubscription to count calls
      const bulkSpy = vi.spyOn(groupService, 'bulkSetAlertSubscription');

      // Mock answerCbQuery with deferred promise
      const deferred = createDeferred<void>();
      const confirmCtx1 = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      confirmCtx1.answerCbQuery = vi.fn().mockReturnValue(deferred.promise);

      // Start first confirm (returns promise immediately, runs sync part)
      const firstPromise = handleGroupAlertsBulkConfirm(confirmCtx1);

      // At this point, transaction has run, state is 'executing', preview is null
      // Second confirm should be rejected
      const confirmCtx2 = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(confirmCtx2);

      expect(confirmCtx2.answerCbQuery).toHaveBeenCalledWith('Preview expired or invalid');
      expect(bulkSpy).toHaveBeenCalledTimes(1);

      // Resolve deferred to let first confirm finish
      deferred.resolve();
      await firstPromise;

      expect(bulkSpy).toHaveBeenCalledTimes(1);
    });

    it('cancel and close during executing are rejected', async () => {
      const c1 = createCustomerWithAccess('GA-152', 'Client A', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false)]);

      // Show bulk preview
      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      const previewId = getPreviewIdFromSession(session);

      // Mock answerCbQuery with deferred promise
      const deferred = createDeferred<void>();
      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      confirmCtx.answerCbQuery = vi.fn().mockReturnValue(deferred.promise);

      // Start first confirm (transaction runs, state → executing)
      const firstPromise = handleGroupAlertsBulkConfirm(confirmCtx);

      // Try cancel
      const cancelCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_cancel:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkCancel(cancelCtx);

      expect(cancelCtx.answerCbQuery).toHaveBeenCalledWith('No pending bulk action to cancel');

      // Try close
      const closeCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_close:${session.token}`,
      });
      await handleGroupAlertsClose(closeCtx);

      expect(closeCtx.answerCbQuery).toHaveBeenCalledWith('A bulk operation is in progress; finish it first');

      // Resolve deferred
      deferred.resolve();
      await firstPromise;

      // Session should be clean after
      expect(session.state).toBe('idle');
      expect(session.currentPreview).toBeNull();
    });

    it('cancel during pending does not trigger transaction', async () => {
      const c1 = createCustomerWithAccess('GA-153', 'Client A', false);
      const c2 = createCustomerWithAccess('GA-154', 'Client B', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false), toMockCustomer(c2, false)]);

      // Show bulk preview
      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      const previewId = getPreviewIdFromSession(session);

      const bulkSpy = vi.spyOn(groupService, 'bulkSetAlertSubscription');

      const cancelCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_cancel:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkCancel(cancelCtx);

      expect(bulkSpy).not.toHaveBeenCalled();
      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c1.id)!.receiveAlerts).toBe(false);
      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c2.id)!.receiveAlerts).toBe(false);
    });
  });

  // =====================================================================
  // SCOPE AND TRANSACTION TESTS (B)
  // =====================================================================
  describe('Scope and transaction', () => {
    it('bulk updates 20 customers across pages', async () => {
      const customers: MockCustomer[] = [];
      for (let i = 0; i < 20; i++) {
        const c = createCustomerWithAccess(`SC-${i}`, `Client ${i}`, false);
        customers.push(toMockCustomer(c, false));
      }
      const session = createSession(GLOBAL_GROUP_ID, true, customers);

      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      expect(bulkCtx.editMessageText.mock.calls[0][0]).toContain('Affected : 20');

      const previewId = getPreviewIdFromSession(session);

      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(confirmCtx);

      for (const c of customers) {
        expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c.customerId)!.receiveAlerts).toBe(true);
      }
      expect(confirmCtx.editMessageText.mock.calls.some(call => call[0].includes('Updated 20 customer(s)') )).toBe(true);
    });

    it('customer added after preview is not included', async () => {
      const c1 = createCustomerWithAccess('SC-NEW-1', 'Client A', false);
      const c2 = createCustomerWithAccess('SC-NEW-2', 'Client B', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false), toMockCustomer(c2, false)]);

      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      // Add new customer after preview - should NOT be included
      const c3 = createCustomerWithAccess('SC-NEW-3', 'Client C', false);

      const previewId = getPreviewIdFromSession(session);

      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(confirmCtx);

      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c1.id)!.receiveAlerts).toBe(true);
      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c2.id)!.receiveAlerts).toBe(true);
      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c3.id)!.receiveAlerts).toBe(false);
    });

    it('removed target causes entire batch rollback', async () => {
      const c1 = createCustomerWithAccess('SC-RM-1', 'Client A', false);
      const c2 = createCustomerWithAccess('SC-RM-2', 'Client B', false);
      const c3 = createCustomerWithAccess('SC-RM-3', 'Client C', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false), toMockCustomer(c2, false), toMockCustomer(c3, false)]);

      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      // Remove c2 from customers table between preview and confirm
      groupRepository.getDb().prepare('DELETE FROM customers WHERE id = ?').run(c2.id);

      const previewId = getPreviewIdFromSession(session);

      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(confirmCtx);

      expect(confirmCtx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('failed'));
      expect(session.state).toBe('idle');
      expect(session.currentPreview).toBeNull();

      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c1.id)!.receiveAlerts).toBe(false);
      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c3.id)!.receiveAlerts).toBe(false);
    });

    it('customer losing can_view after preview causes batch rollback', async () => {
      const groupService_reg = vi.spyOn(groupService, 'bulkSetAlertSubscription');
      const c1 = createCustomerWithAccess('SC-CV-1', 'Client A', false);
      const c2 = createCustomerWithAccess('SC-CV-2', 'Client B', false);
      groupService.register(ORDINARY_GROUP_ID, 'Test Group');
      groupRepository.assignCustomer({ groupChatId: ORDINARY_GROUP_ID, customerId: c1.id, canView: true, receiveAlerts: false });
      groupRepository.assignCustomer({ groupChatId: ORDINARY_GROUP_ID, customerId: c2.id, canView: true, receiveAlerts: false });

      const session = createSession(ORDINARY_GROUP_ID, false, [toMockCustomer(c1, false, true), toMockCustomer(c2, false, true)]);

      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: ORDINARY_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      // Revoke can_view for c2 between preview and confirm
      groupRepository.getDb().prepare('UPDATE group_customer_access SET can_view = 0 WHERE group_chat_id = ? AND customer_id = ?').run(ORDINARY_GROUP_ID, c2.id);

      const previewId = getPreviewIdFromSession(session);

      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: ORDINARY_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(confirmCtx);

      expect(confirmCtx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('failed'));
      expect(groupRepository.getAccess(ORDINARY_GROUP_ID, c1.id)!.receiveAlerts).toBe(false);
      expect(groupRepository.getAccess(ORDINARY_GROUP_ID, c2.id)!.receiveAlerts).toBe(false);
    });

    it('already-target-state customer is no-op and not counted', async () => {
      const c1 = createCustomerWithAccess('SC-NOOP-1', 'Client A', true);  // already ON
      const c2 = createCustomerWithAccess('SC-NOOP-2', 'Client B', false); // OFF -> needs ON
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, true), toMockCustomer(c2, false)]);

      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      expect(bulkCtx.editMessageText.mock.calls[0][0]).toContain('Affected : 1');

      const previewId = getPreviewIdFromSession(session);

      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(confirmCtx);

      expect(confirmCtx.editMessageText.mock.calls.some(call => call[0].includes('Updated 1 customer(s)') )).toBe(true);
    });

    it('out-of-scope customer data is preserved', async () => {
      const c1 = createCustomerWithAccess('SC-OS-1', 'Client A', false);
      const c2 = createCustomerWithAccess('SC-OS-2', 'Client B', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false), toMockCustomer(c2, false)]);

      // Register ordinary group and set can_view=false, receive_alerts=true
      groupService.register(ORDINARY_GROUP_ID, 'Test Group');
      groupRepository.getDb().prepare('INSERT OR REPLACE INTO group_customer_access (group_chat_id, customer_id, can_view, receive_alerts, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)')
        .run(ORDINARY_GROUP_ID, c1.id, new Date().toISOString(), new Date().toISOString());

      // Bulk enable for Global Group
      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      const previewId = getPreviewIdFromSession(session);

      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(confirmCtx);

      // Ordinary group access row is untouched
      const access = groupRepository.getAccess(ORDINARY_GROUP_ID, c1.id);
      expect(access!.receiveAlerts).toBe(true);
      expect(access!.canView).toBe(false);
    });

    it('valid customer already at target state follows confirmed target (no flip)', async () => {
      const c1 = createCustomerWithAccess('SC-FOLLOW-1', 'Client A', true);  // already ON
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, true)]);

      // Bulk disable (target = OFF), but c1 is already ON at preview time
      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:disable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      // At confirm time, c1 is still ON -> should be disabled
      const previewId = getPreviewIdFromSession(session);

      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(confirmCtx);

      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c1.id)!.receiveAlerts).toBe(false);
    });
  });

  // =====================================================================
  // DATABASE BARU TESTS (C)
  // =====================================================================
  describe('Database baru (Global Group)', () => {
    it('bulk enable creates Global Group row if not exists', async () => {
      const c1 = customerService.create({ clientId: 'GA-NEW-1', name: 'Client A', monitorType: 'prtg', pingHost: null, enabled: true });
      const c2 = customerService.create({ clientId: 'GA-NEW-2', name: 'Client B', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true });
      groupRepository.setAlertSubscription({ groupChatId: GLOBAL_GROUP_ID, customerId: c1.id, receiveAlerts: false });
      groupRepository.setAlertSubscription({ groupChatId: GLOBAL_GROUP_ID, customerId: c2.id, receiveAlerts: false });

      // Delete Global Group row from telegram_groups
      groupRepository.getDb().prepare('DELETE FROM telegram_groups WHERE chat_id = ?').run(GLOBAL_GROUP_ID);

      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false), toMockCustomer(c2, false)]);

      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      const previewId = getPreviewIdFromSession(session);

      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(confirmCtx);

      const grp = groupRepository.getDb().prepare('SELECT * FROM telegram_groups WHERE chat_id = ?').get(GLOBAL_GROUP_ID) as { title: string; enabled: number; registered_at: string } | undefined;
      expect(grp).toBeDefined();
      expect(grp!.title).toBe('Global Group');
      expect(grp!.enabled).toBe(1);

      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c1.id)!.receiveAlerts).toBe(true);
      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c2.id)!.receiveAlerts).toBe(true);
    });

    it('existing Global Group row attributes are preserved', async () => {
      const c1 = createCustomerWithAccess('GA-NEW-3', 'Client A', false);
      // Insert with custom title and enabled=0
      groupRepository.getDb().prepare(`
        INSERT OR REPLACE INTO telegram_groups (chat_id, title, enabled, registered_at)
        VALUES (?, 'Custom Title', 0, '2020-01-01T00:00:00Z')
      `).run(GLOBAL_GROUP_ID);

      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false)]);

      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      const previewId = getPreviewIdFromSession(session);

      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(confirmCtx);

      const grp = groupRepository.getDb().prepare('SELECT * FROM telegram_groups WHERE chat_id = ?').get(GLOBAL_GROUP_ID) as { title: string; enabled: number; registered_at: string } | undefined;
      expect(grp!.title).toBe('Custom Title');
      expect(grp!.enabled).toBe(0);
      expect(grp!.registered_at).toBe('2020-01-01T00:00:00Z');
    });

    it('transaction failure does not leave Global Group row created', async () => {
      const c1 = customerService.create({ clientId: 'GA-NEW-4', name: 'Client A', monitorType: 'prtg', pingHost: null, enabled: true });
      groupRepository.setAlertSubscription({ groupChatId: GLOBAL_GROUP_ID, customerId: c1.id, receiveAlerts: false });

      // Delete both Global Group row and the customer (to cause validation failure)
      groupRepository.getDb().prepare('DELETE FROM telegram_groups WHERE chat_id = ?').run(GLOBAL_GROUP_ID);
      groupRepository.getDb().prepare('DELETE FROM customers WHERE id = ?').run(c1.id);

      const session = createSession(GLOBAL_GROUP_ID, true, [{
        customerId: c1.id, clientId: c1.clientId, name: c1.name,
        monitorType: c1.monitorType, canView: true, enabled: true, receiveAlerts: false,
      }]);

      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      const previewId = getPreviewIdFromSession(session);

      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      await handleGroupAlertsBulkConfirm(confirmCtx);

      // Global Group row should NOT exist (rolled back)
      const grp = groupRepository.getDb().prepare('SELECT * FROM telegram_groups WHERE chat_id = ?').get(GLOBAL_GROUP_ID);
      expect(grp).toBeUndefined();

      expect(session.state).toBe('idle');
      expect(session.currentPreview).toBeNull();
    });
  });

  // =====================================================================
  // TOGGLE & VALIDATION TESTS (D)
  // =====================================================================
  describe('Toggle and validation', () => {
    it('permission revocation after menu open is rejected', async () => {
      const c1 = createCustomerWithAccess('GA-VAL-1', 'Client A', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false)]);

      // Revoke admin permission at runtime
      vi.spyOn(accessService, 'isAdmin').mockReturnValue(false);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${c1.id}:on`,
      });
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Admin access required in this group');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c1.id)!.receiveAlerts).toBe(false);
    });

    it('unregistered group after menu open is rejected', async () => {
      const c1 = createCustomerWithAccess('GA-VAL-2', 'Client A', false);
      const session = createSession(ORDINARY_GROUP_ID, false, [toMockCustomer(c1, false, true)]);

      vi.spyOn(accessService, 'isGroupRegistered').mockReturnValue(false);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: ORDINARY_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${c1.id}:on`,
      });
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Admin access required in this group');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });

    it('expired session is rejected', async () => {
      const session = createSession(GLOBAL_GROUP_ID, true, []);

      // Simulate expiry by modifying expiresAt
      session.expiresAt = new Date(Date.now() - 1000);
      expect(groupAlertsStore.get(session.token)).toBeUndefined();

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_close:${session.token}`,
      });
      await handleGroupAlertsClose(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('expired'));
    });

    it('revoked can_view after menu open causes toggle rejection', async () => {
      groupService.register(ORDINARY_GROUP_ID, 'Test Group');
      const c1 = customerService.create({ clientId: 'GA-VAL-3', name: 'Client A', monitorType: 'prtg', pingHost: null, enabled: true });
      groupRepository.assignCustomer({ groupChatId: ORDINARY_GROUP_ID, customerId: c1.id, canView: true, receiveAlerts: false });
      const session = createSession(ORDINARY_GROUP_ID, false, [toMockCustomer(c1, false, true)]);

      // Revoke can_view for the customer in DB
      groupRepository.getDb().prepare('UPDATE group_customer_access SET can_view = 0 WHERE group_chat_id = ? AND customer_id = ?').run(ORDINARY_GROUP_ID, c1.id);

      const ctx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: ORDINARY_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_toggle:${session.token}:${c1.id}:on`,
      });
      await handleGroupAlertsToggle(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('not in this view or visibility revoked'));
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // UI FAILURE TESTS (E)
  // =====================================================================
  describe('UI failures', () => {
    it('preview edit failure does not leave session locked', async () => {
      const c1 = createCustomerWithAccess('GA-UI-1', 'Client A', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false)]);

      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });

      // Mock editMessageText to reject
      bulkCtx.editMessageText = vi.fn().mockRejectedValue(new Error('Telegram error'));

      await handleGroupAlertsBulk(bulkCtx);

      expect(session.state).toBe('idle');
      expect(session.currentPreview).toBeNull();
      expect(bulkCtx.answerCbQuery).toHaveBeenCalledWith('Failed to prepare bulk action');
    });

    it('Telegram edit failure after commit: DB correct, preview consumed, no re-transaction', async () => {
      const c1 = createCustomerWithAccess('GA-UI-2', 'Client A', false);
      const c2 = createCustomerWithAccess('GA-UI-3', 'Client B', false);
      const session = createSession(GLOBAL_GROUP_ID, true, [toMockCustomer(c1, false), toMockCustomer(c2, false)]);

      // Show bulk preview
      const bulkCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `alerts_bulk:${session.token}:enable_all`,
      });
      await handleGroupAlertsBulk(bulkCtx);

      const previewId = getPreviewIdFromSession(session);

      const bulkSpy = vi.spyOn(groupService, 'bulkSetAlertSubscription');

      const confirmCtx = makeContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'supergroup',
        callbackQueryData: `ga_confirm:${session.token}:${previewId}`,
      });
      // Mock editMessageText to reject
      confirmCtx.editMessageText = vi.fn().mockRejectedValue(new Error('Telegram edit error'));
      // answerCbQuery should succeed (it has .catch internally)
      confirmCtx.answerCbQuery = vi.fn().mockResolvedValue(undefined);

      await handleGroupAlertsBulkConfirm(confirmCtx);

      // DB changes are correct
      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c1.id)!.receiveAlerts).toBe(true);
      expect(groupRepository.getAccess(GLOBAL_GROUP_ID, c2.id)!.receiveAlerts).toBe(true);

      // Preview consumed
      expect(session.currentPreview).toBeNull();
      expect(session.state).toBe('idle');

      // Transaction not re-run
      expect(bulkSpy).toHaveBeenCalledTimes(1);
    });
  });

  // =====================================================================
  // STORE TESTS
  // =====================================================================
  describe('Group alerts store', () => {
    it('enforces max sessions limit', () => {
      for (let i = 0; i < 200; i++) {
        groupAlertsStore.create({
          userId: ADMIN_USER_ID,
          chatId: GLOBAL_GROUP_ID,
          messageId: null,
          isGlobalGroup: true,
          customers: [],
        });
      }
      expect(() => groupAlertsStore.create({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        messageId: null,
        isGlobalGroup: true,
        customers: [],
      })).toThrow('Group alerts store is full');
    });

    it('generates unique 16-byte preview IDs (22 char base64url)', () => {
      const id1 = groupAlertsStore.generatePreviewId();
      const id2 = groupAlertsStore.generatePreviewId();
      expect(id1).not.toBe(id2);
      expect(id1.length).toBe(22); // 16 bytes in base64url = 22 chars
    });

    it('generates unique 128-bit session tokens (22 char base64url)', () => {
      const session = groupAlertsStore.create({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        messageId: null,
        isGlobalGroup: true,
        customers: [],
      });
      expect(session.token.length).toBe(22); // 16 bytes in base64url = 22 chars
    });
  });

  // =====================================================================
  // CALLBACK FORMAT TESTS
  // =====================================================================
  describe('Callback data byte-size and format', () => {
    it('rejects oversized payload in parser', () => {
      const longToken = 'a'.repeat(100);
      const parsed = parseGroupAlertsCallback(`alerts_close:${longToken}`);
      expect(parsed).toBeNull();
    });

    it('accepts ga_confirm payload within 64 bytes', () => {
      const token = 'a'.repeat(22);
      const previewId = 'b'.repeat(22);
      const data = `ga_confirm:${token}:${previewId}`;
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
      const parsed = parseGroupAlertsCallback(data);
      expect(parsed).not.toBeNull();
      expect(parsed!.action).toBe('ga_confirm');
      expect(parsed!.previewId).toBe(previewId);
    });

    it('rejects old alerts_bulk_confirm prefix', () => {
      const parsed = parseGroupAlertsCallback('alerts_bulk_confirm:token123:preview456');
      expect(parsed).toBeNull();
    });

    it('toggle with invalid target is rejected by parser', () => {
      const parsed = parseGroupAlertsCallback('alerts_toggle:token123:42:invalid');
      expect(parsed).toBeNull();
    });
  });
});
