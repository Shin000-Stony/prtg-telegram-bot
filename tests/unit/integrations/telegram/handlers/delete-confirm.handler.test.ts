import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting, getDatabase } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { handleDeleteConfirm, handleDeleteCancel } from '@/integrations/telegram/handlers/delete-confirm.handler';
import { pendingDeleteStore } from '@/modules/customers/pending-delete.store';
import { customerRepository } from '@/modules/customers/customer.repository';
import { customerService } from '@/modules/customers/customer.service';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import { alertRepository } from '@/modules/alerts/alert.repository';
import { accessService } from '@/modules/groups/access.service';
import { monitoringRepository } from '@/modules/monitoring/monitoring.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('delete-confirm handlers', () => {
  let testDir: string;
  let testDbPath: string;

  const ADMIN_USER_ID = '123456789';
  const GLOBAL_GROUP_ID = '-1001234567890';

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-delcon-'));
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetConfigForTesting();
    pendingDeleteStore.clear();
    await rm(testDir, { recursive: true, force: true });
  });

  function makeMockContext(overrides: {
    userId: string;
    chatId: string;
    chatType: string;
    callbackQueryData: string;
    fromId?: string;
  }) {
    const answerCbQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const fromId = overrides.fromId || overrides.userId;
    return {
      userId: overrides.userId,
      chatId: overrides.chatId,
      chatType: overrides.chatType,
      from: { id: BigInt(fromId) },
      callbackQuery: {
        data: overrides.callbackQueryData,
        id: 'query1',
        from: { id: BigInt(fromId) },
      },
      answerCbQuery,
      editMessageText,
    } as any;
  }

  function createCustomerWithData(clientId: string, name: string) {
    const customer = customerRepository.create({
      clientId,
      name,
      monitorType: 'prtg',
      pingHost: null,
      enabled: true,
    });

    mappingRepository.create({
      customerId: customer.id,
      prtgObjectId: 1001,
      prtgDeviceName: 'Device',
      prtgSensorName: 'Sensor',
      mappingMethod: 'manual',
      confidence: null,
      verified: true,
      mappedByTelegramId: ADMIN_USER_ID,
    });

    groupRepository.upsert('-1001999999999', 'Test Group');
    groupRepository.assignCustomer({
      groupChatId: '-1001999999999',
      customerId: customer.id,
      canView: true,
      receiveAlerts: true,
    });

    // Insert a monitoring state
    getDatabase().prepare(
      'INSERT INTO monitoring_states (customer_id, monitor_type, target_fingerprint, stable_health, latest_observation, latest_reason, latest_raw_status, observed_at, last_attempt_at, last_observation_at, last_good_observation_at, consecutive_count, stable_changed_at, last_transition_kind, last_transition_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(customer.id, 'prtg', 'test-fingerprint', 'UP', 'UP', 'test', 1, Date.now(), Date.now(), Date.now(), Date.now(), 1, Date.now(), 'UP', Date.now(), Date.now(), Date.now());

    // Insert a pending alert
    getDatabase().prepare(
      'INSERT INTO alert_outbox (event_key, group_chat_id, customer_id, kind, target_fingerprint, monitor_type, triggering_observation_id, occurrence_at, expires_at, client_id, customer_name, monitor_source, target_display, status, attempts, next_attempt_at, last_attempt_at, sent_at, telegram_message_id, error_code, error_reason, created_at, updated_at, prtg_object_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('evt-1', '-1001999999999', customer.id, 'DOWN', 'test-fingerprint', 'prtg', 'obs-1', Date.now(), Date.now() + 300000, customer.clientId, customer.name, 'prtg', 'test-target', 'pending', 0, Date.now() + 60000, null, null, null, null, null, Date.now(), Date.now(), null);

    return customer;
  }

  describe('confirm', () => {
    it('deletes customer and all cascade data within transaction', async () => {
      const customer = createCustomerWithData('DEL-CONF-001', 'Delete Confirm Test');

      const session = pendingDeleteStore.create({
        customerId: customer.id,
        clientId: customer.clientId,
        name: customer.name,
        chatId: GLOBAL_GROUP_ID,
        userId: ADMIN_USER_ID,
      });

      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'private',
        callbackQueryData: `delete_confirm:${session.id}`,
      });

      await handleDeleteConfirm(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Deleting...');
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('✅ <b>CUSTOMER DELETED</b>'), { parse_mode: 'HTML' });

      // Customer is deleted
      expect(customerRepository.findById(customer.id)).toBeNull();

      // Cascading deletes via FK
      expect(mappingRepository.findByCustomerId(customer.id)).toBeNull();
      expect(groupRepository.getAccess('-1001999999999', customer.id)).toBeNull();

      // Monitoring state deleted
      expect(monitoringRepository.findById(customer.id)).toBeNull();

      // Alert outbox cleaned
      const alertRows = getDatabase().prepare('SELECT * FROM alert_outbox WHERE customer_id = ?').all(customer.id) as any[];
      expect(alertRows.length).toBe(0);

      // Session consumed
      expect(pendingDeleteStore.get(session.id)).toBeUndefined();
    });

     it('different user cannot confirm', async () => {
       const customer = customerRepository.create({
         clientId: 'DEL-USER-001',
         name: 'User Test',
         monitorType: 'prtg',
         pingHost: null,
         enabled: true,
       });

       const session = pendingDeleteStore.create({
         customerId: customer.id,
         clientId: customer.clientId,
         name: customer.name,
         chatId: GLOBAL_GROUP_ID,
         userId: ADMIN_USER_ID,
       });

       const ctx = makeMockContext({
         userId: '999999999',
         chatId: GLOBAL_GROUP_ID,
         chatType: 'private',
         callbackQueryData: `delete_confirm:${session.id}`,
         fromId: '999999999',
       });

       await handleDeleteConfirm(ctx);

       expect(ctx.answerCbQuery).toHaveBeenCalledWith('Only the original requester can confirm');
       expect(ctx.editMessageText).not.toHaveBeenCalled();

       // Customer should still exist
       expect(customerRepository.findById(customer.id)).not.toBeNull();
       // Session should still be valid (not consumed)
       expect(pendingDeleteStore.get(session.id)).toBeDefined();
     });

     it('different chat cannot confirm', async () => {
       const customer = customerRepository.create({
         clientId: 'DEL-CHAT-001',
         name: 'Chat Test',
         monitorType: 'prtg',
         pingHost: null,
         enabled: true,
       });

       const session = pendingDeleteStore.create({
         customerId: customer.id,
         clientId: customer.clientId,
         name: customer.name,
         chatId: GLOBAL_GROUP_ID,
         userId: ADMIN_USER_ID,
       });

       const ctx = makeMockContext({
         userId: ADMIN_USER_ID,
         chatId: '-1009999999999',
         chatType: 'private',
         callbackQueryData: `delete_confirm:${session.id}`,
       });

       await handleDeleteConfirm(ctx);

       expect(ctx.answerCbQuery).toHaveBeenCalledWith('This delete request belongs to a different chat');
       expect(ctx.editMessageText).not.toHaveBeenCalled();
       expect(customerRepository.findById(customer.id)).not.toBeNull();
       expect(pendingDeleteStore.get(session.id)).toBeDefined();
     });

     it('denies admin whose permission was revoked after session creation', async () => {
       vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(false);
       const customer = customerRepository.create({
         clientId: 'DEL-REVOK-001',
         name: 'Revoked Test',
         monitorType: 'prtg',
         pingHost: null,
         enabled: true,
       });

       const session = pendingDeleteStore.create({
         customerId: customer.id,
         clientId: customer.clientId,
         name: customer.name,
         chatId: GLOBAL_GROUP_ID,
         userId: ADMIN_USER_ID,
       });

       const ctx = makeMockContext({
         userId: ADMIN_USER_ID,
         chatId: GLOBAL_GROUP_ID,
         chatType: 'private',
         callbackQueryData: `delete_confirm:${session.id}`,
       });

       await handleDeleteConfirm(ctx);

       expect(ctx.answerCbQuery).toHaveBeenCalledWith('No longer authorized to delete customers');
       expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('No longer authorized'));
       expect(customerRepository.findById(customer.id)).not.toBeNull();
       expect(pendingDeleteStore.get(session.id)).toBeDefined();
     });

    it('expired session is rejected', async () => {
      const customer = customerRepository.create({
        clientId: 'DEL-EXP-001',
        name: 'Expire Test',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });

      const session = pendingDeleteStore.create({
        customerId: customer.id,
        clientId: customer.clientId,
        name: customer.name,
        chatId: GLOBAL_GROUP_ID,
        userId: ADMIN_USER_ID,
      });
      session.expiresAt = new Date(Date.now() - 1000);

      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'private',
        callbackQueryData: `delete_confirm:${session.id}`,
      });

      await handleDeleteConfirm(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Delete session expired or invalid');
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('expired'));
      expect(customerRepository.findById(customer.id)).not.toBeNull();
    });

    it('unknown token is rejected', async () => {
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'private',
        callbackQueryData: 'delete_confirm:unknown-token-12345',
      });

      await handleDeleteConfirm(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Delete session expired or invalid');
    });

    it('already consumed token cannot be reused', async () => {
      const customer = customerRepository.create({
        clientId: 'DEL-DOUBLE-001',
        name: 'Double Confirm Test',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });

      const session = pendingDeleteStore.create({
        customerId: customer.id,
        clientId: customer.clientId,
        name: customer.name,
        chatId: GLOBAL_GROUP_ID,
        userId: ADMIN_USER_ID,
      });

      pendingDeleteStore.consume(session.id);

      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'private',
        callbackQueryData: `delete_confirm:${session.id}`,
      });

      await handleDeleteConfirm(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Delete session expired or invalid');
      expect(customerRepository.findById(customer.id)).not.toBeNull();
    });

    it('invalid callback is rejected', async () => {
      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'private',
        callbackQueryData: 'invalid_callback_data',
      });

      await handleDeleteConfirm(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Invalid callback');
    });

    it('transaction rollback: alert cancellation + customer deletion undone on failure', async () => {
      const customer = createCustomerWithData('DEL-RB-001', 'Rollback Test');

      const session = pendingDeleteStore.create({
        customerId: customer.id,
        clientId: customer.clientId,
        name: customer.name,
        chatId: GLOBAL_GROUP_ID,
        userId: ADMIN_USER_ID,
      });

      // Mock customerService.delete to throw after alert cancellation
      const deleteSpy = vi.spyOn(customerService, 'delete').mockImplementation((id: number) => {
        throw new Error('Simulated delete failure');
      });

      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'private',
        callbackQueryData: `delete_confirm:${session.id}`,
      });

      await handleDeleteConfirm(ctx);

      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Failed to delete customer'));

      // Alert cancellation should be rolled back (alert still pending)
      const alertRows = getDatabase().prepare('SELECT * FROM alert_outbox WHERE customer_id = ?').all(customer.id) as any[];
      expect(alertRows.length).toBe(1);
      expect(alertRows[0].status).toBe('pending');

      // Customer should still exist
      expect(customerRepository.findById(customer.id)).not.toBeNull();
      // Session should not be consumed (still exists)
      expect(pendingDeleteStore.get(session.id)).toBeDefined();

      deleteSpy.mockRestore();
    });
  });

  describe('cancel', () => {
    it('cancels and preserves customer', async () => {
      const customer = createCustomerWithData('DEL-CANCEL-001', 'Cancel Test');

      const session = pendingDeleteStore.create({
        customerId: customer.id,
        clientId: customer.clientId,
        name: customer.name,
        chatId: GLOBAL_GROUP_ID,
        userId: ADMIN_USER_ID,
      });

      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'private',
        callbackQueryData: `delete_cancel:${session.id}`,
      });

      await handleDeleteCancel(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Cancelled');
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('❌ Deletion cancelled'));

      // Customer should still exist with all data
      expect(customerRepository.findById(customer.id)).not.toBeNull();
      expect(mappingRepository.findByCustomerId(customer.id)).not.toBeNull();

      // Session should be removed
      expect(pendingDeleteStore.get(session.id)).toBeUndefined();
    });

    it('different user cannot cancel', async () => {
      const customer = customerRepository.create({
        clientId: 'DEL-UCANCEL-001',
        name: 'User Cancel Test',
        monitorType: 'prtg',
        pingHost: null,
        enabled: true,
      });

      const session = pendingDeleteStore.create({
        customerId: customer.id,
        clientId: customer.clientId,
        name: customer.name,
        chatId: GLOBAL_GROUP_ID,
        userId: ADMIN_USER_ID,
      });

      const ctx = makeMockContext({
        userId: '999999999',
        chatId: GLOBAL_GROUP_ID,
        chatType: 'private',
        callbackQueryData: `delete_cancel:${session.id}`,
        fromId: '999999999',
      });

      await handleDeleteCancel(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Only the original requester can cancel');
      expect(ctx.editMessageText).not.toHaveBeenCalled();
      expect(pendingDeleteStore.get(session.id)).toBeDefined();
    });

    it('expired session cancel is rejected', async () => {
      const session = pendingDeleteStore.create({
        customerId: 1,
        clientId: 'EXP-CANCEL',
        name: 'Expire Cancel Test',
        chatId: GLOBAL_GROUP_ID,
        userId: ADMIN_USER_ID,
      });
      session.expiresAt = new Date(Date.now() - 1000);

      const ctx = makeMockContext({
        userId: ADMIN_USER_ID,
        chatId: GLOBAL_GROUP_ID,
        chatType: 'private',
        callbackQueryData: `delete_cancel:${session.id}`,
      });

      await handleDeleteCancel(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Delete session expired or invalid');
    });
  });
});
