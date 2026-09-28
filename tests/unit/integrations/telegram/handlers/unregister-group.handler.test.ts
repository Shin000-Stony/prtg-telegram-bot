import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting, getDatabase } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { handleUnregisterConfirm, handleUnregisterCancel } from '@/integrations/telegram/handlers/unregister-group.handler';
import { pendingUnregisterStore } from '@/modules/groups/pending-unregister.store';
import { groupService } from '@/modules/groups/group.service';
import { groupRepository } from '@/modules/groups/group.repository';
import { customerService } from '@/modules/customers/customer.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/unregister_group callback', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-unreg-'));
    testDbPath = join(testDir, 'test.db');
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', '123456789');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
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
    resetConfigForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  function makeMockContext(overrides: {
    userId: string;
    chatId: string;
    chatType: string;
    callbackQueryData: string;
    fromId: string;
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

  describe('confirm', () => {
    it('original admin + original chat + valid token -> succeeds', async () => {
      groupRepository.upsert('-100111111501', 'Test Group');
      const pending = pendingUnregisterStore.create('-100111111501', '123456789');
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '123456789',
        chatId: '-100111111501',
        chatType: 'group',
        callbackQueryData: `group_unregister_confirm:${token}`,
        fromId: '123456789',
      });
      
      await handleUnregisterConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Unregistering...');
      expect(ctx.editMessageText).toHaveBeenCalledWith('✅ Group unregistered successfully', { parse_mode: 'HTML' });
      
      // Verify group is unregistered
      expect(groupRepository.findByChatId('-100111111501')).toBeNull();
    });

    it('different user -> denied', async () => {
      groupRepository.upsert('-100111111502', 'Test Group');
      const pending = pendingUnregisterStore.create('-100111111502', '123456789');
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '999999998',
        chatId: '-100111111502',
        chatType: 'group',
        callbackQueryData: `group_unregister_confirm:${token}`,
        fromId: '999999998',
      });
      
await handleUnregisterConfirm(ctx);
       
       expect(ctx.answerCbQuery).toHaveBeenCalledWith('Only the original requester can confirm');
     });

    it('different chat -> denied', async () => {
      groupRepository.upsert('-100111111503', 'Test Group');
      const pending = pendingUnregisterStore.create('-100111111503', '123456789');
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '123456789',
        chatId: '-999999999',
        chatType: 'group',
        callbackQueryData: `group_unregister_confirm:${token}`,
        fromId: '123456789',
      });
      
      await handleUnregisterConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('This unregister belongs to a different chat');
    });

    it('expired -> denied', async () => {
      groupRepository.upsert('-100111111504', 'Test Group');
      const pending = pendingUnregisterStore.create('-100111111504', '123456789');
      pending.expiresAt = new Date(Date.now() - 1000);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '123456789',
        chatId: '-100111111504',
        chatType: 'group',
        callbackQueryData: `group_unregister_confirm:${token}`,
        fromId: '123456789',
      });
      
      await handleUnregisterConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Unregister session expired or invalid');
      expect(ctx.editMessageText).toHaveBeenCalledWith('❌ Unregister session expired or invalid');
    });

    it('cancelled -> denied', async () => {
      groupRepository.upsert('-100111111505', 'Test Group');
      const pending = pendingUnregisterStore.create('-100111111505', '123456789');
      pendingUnregisterStore.delete(pending.id);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '123456789',
        chatId: '-100111111505',
        chatType: 'group',
        callbackQueryData: `group_unregister_confirm:${token}`,
        fromId: '123456789',
      });
      
      await handleUnregisterConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Unregister session expired or invalid');
    });

    it('consumed -> cannot run twice', async () => {
      groupRepository.upsert('-100111111506', 'Test Group');
      const pending = pendingUnregisterStore.create('-100111111506', '123456789');
      pendingUnregisterStore.consume(pending.id);
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '123456789',
        chatId: '-100111111506',
        chatType: 'group',
        callbackQueryData: `group_unregister_confirm:${token}`,
        fromId: '123456789',
      });
      
      await handleUnregisterConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Unregister session expired or invalid');
    });

    it('Global Group cannot be disabled by callback trickery', async () => {
      const pending = pendingUnregisterStore.create('-1001234567890', '123456789');
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '123456789',
        chatId: '-1001234567890',
        chatType: 'supergroup',
        callbackQueryData: `group_unregister_confirm:${token}`,
        fromId: '123456789',
      });
      
      await handleUnregisterConfirm(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Unregister session expired or invalid');
    });
  });

  describe('cancel', () => {
    it('cancel removes pending action', async () => {
      groupRepository.upsert('-100111111507', 'Test Group');
      const pending = pendingUnregisterStore.create('-100111111507', '123456789');
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '123456789',
        chatId: '-100111111507',
        chatType: 'group',
        callbackQueryData: `group_unregister_cancel:${token}`,
        fromId: '123456789',
      });
      
      await handleUnregisterCancel(ctx);
      
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Cancelled');
      expect(ctx.editMessageText).toHaveBeenCalledWith('❌ Unregister cancelled');
    });
  });

  describe('callback query always answered', () => {
    it('confirm always calls answerCbQuery', async () => {
      groupRepository.upsert('-100111111508', 'Test Group');
      const pending = pendingUnregisterStore.create('-100111111508', '123456789');
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '123456789',
        chatId: '-100111111508',
        chatType: 'group',
        callbackQueryData: `group_unregister_confirm:${token}`,
        fromId: '123456789',
      });
      
      await handleUnregisterConfirm(ctx);
      expect(ctx.answerCbQuery).toHaveBeenCalled();
    });

    it('cancel always calls answerCbQuery', async () => {
      const pending = pendingUnregisterStore.create('-100111111509', '123456789');
      const token = pending.id;
      
      const ctx = makeMockContext({
        userId: '123456789',
        chatId: '-100111111509',
        chatType: 'group',
        callbackQueryData: `group_unregister_cancel:${token}`,
        fromId: '123456789',
      });
      
      await handleUnregisterCancel(ctx);
      expect(ctx.answerCbQuery).toHaveBeenCalled();
    });

    it('invalid callback -> answers', async () => {
      const ctx = makeMockContext({
        userId: '123456789',
        chatId: '-100111111510',
        chatType: 'group',
        callbackQueryData: 'invalid_callback',
        fromId: '123456789',
      });
      
      await handleUnregisterConfirm(ctx);
      expect(ctx.answerCbQuery).toHaveBeenCalledWith('Invalid callback');
    });

    // Regression: Unregister confirm with same owner but revoked admin permission
    it('denies same owner after admin permission revoked', async () => {
      const customer = customerService.create({ clientId: 'UNREG-CUST', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      groupRepository.upsert('-100111111511', 'Test Group');
      groupRepository.assignCustomer({ groupChatId: '-100111111511', customerId: customer.id, canView: true, receiveAlerts: false });
      const pending = pendingUnregisterStore.create('-100111111511', '123456789');
      const token = pending.id;
      
      // Revoke admin permission
      vi.stubEnv('TELEGRAM_ADMIN_IDS', '');
      resetConfigForTesting();
      
      const ctx = makeMockContext({
        userId: '123456789',
        chatId: '-100111111511',
        chatType: 'group',
        callbackQueryData: `group_unregister_confirm:${token}`,
        fromId: '123456789',
      });
      await handleUnregisterConfirm(ctx);
      
      // Should deny with authorization message
      expect(ctx.answerCbQuery).toHaveBeenCalled();
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('No longer authorized'));
      
      // Group and access rows should be unchanged
      expect(groupRepository.findByChatId('-100111111511')).not.toBeNull();
      const accessCount = getDatabase().prepare('SELECT count(*) AS n FROM group_customer_access WHERE group_chat_id=?').get('-100111111511').n;
      expect(accessCount).toBe(1);
      
      // Token should be retained (not consumed)
      expect(pendingUnregisterStore.get(token)).toBeDefined();
    });
  });
});