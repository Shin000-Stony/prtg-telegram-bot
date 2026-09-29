import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { deleteClientCommand } from '@/integrations/telegram/commands/delete-client.command';
import { accessService } from '@/modules/groups/access.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import { alertRepository } from '@/modules/alerts/alert.repository';
import { pendingDeleteStore } from '@/modules/customers/pending-delete.store';
import { parse } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('deleteClientCommand', () => {
  let testDir: string;
  let testDbPath: string;

  const ADMIN_USER_ID = '123456789';
  const GLOBAL_GROUP_ID = '-1001234567890';

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-delete-cmd-'));
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
    resetConfigForTesting();
    pendingDeleteStore.clear();
    await rm(testDir, { recursive: true, force: true });
  });

  function createMockContext(overrides: {
    userId?: string;
    chatId?: string;
    chatType?: string;
    text?: string;
  } = {}) {
    const reply = vi.fn().mockResolvedValue(undefined);
    return {
      userId: overrides.userId || ADMIN_USER_ID,
      chatId: overrides.chatId || GLOBAL_GROUP_ID,
      chatType: overrides.chatType || 'private',
      message: { text: overrides.text || '/delete_client TEST-001' },
      reply,
    } as any;
  }

  it('denies non-admin in private chat', async () => {
    vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(false);
    const ctx = createMockContext({ userId: '999999999', chatType: 'private', text: '/delete_client TEST-001' });
    await deleteClientCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('admin privileges'));
  });

  it('shows usage when no client_id provided', async () => {
    vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
    const ctx = createMockContext({ text: '/delete_client' });
    await deleteClientCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'), expect.objectContaining({ parse_mode: 'HTML' }));
  });

  it('shows preview with counts (preview does not modify DB)', async () => {
    vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
    const customer = customerRepository.create({
      clientId: 'PREV-TEST-001',
      name: 'Preview Customer',
      monitorType: 'prtg',
      pingHost: null,
      enabled: true,
    });

    // Add a PRTG mapping
    mappingRepository.create({
      customerId: customer.id,
      prtgObjectId: 9999,
      prtgDeviceName: null,
      prtgSensorName: null,
      mappingMethod: 'manual',
      confidence: null,
      verified: true,
      mappedByTelegramId: ADMIN_USER_ID,
    });

    // Register group and add group access
    groupRepository.upsert('-100111111500', 'Test Group');
    groupRepository.assignCustomer({
      groupChatId: '-100111111500',
      customerId: customer.id,
      canView: true,
      receiveAlerts: true,
    });

    const ctx = createMockContext({ text: '/delete_client PREV-TEST-001' });
    await deleteClientCommand(ctx);

    // Should send preview message
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyArg = ctx.reply.mock.calls[0][0];
    expect(replyArg).toContain('DELETE CUSTOMER');
    expect(replyArg).toContain('PREV-TEST-001');
    expect(replyArg).toContain('Preview Customer');
    expect(replyArg).toContain('1 PRTG mapping(s)');
    expect(replyArg).toContain('1 group access assignment(s)');

    // Verify DB was NOT modified (preview only)
    expect(customerRepository.findByClientId('PREV-TEST-001')).not.toBeNull();
    expect(mappingRepository.findByCustomerId(customer.id)).not.toBeNull();

    // Verify pending session was created
    const pendingKeys = Array.from((pendingDeleteStore as any).store.keys());
    expect(pendingKeys.length).toBe(1);
    const session = pendingDeleteStore.get(pendingKeys[0]);
    expect(session?.customerId).toBe(customer.id);
  });

  it('shows error for non-existent client', async () => {
    vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
    const ctx = createMockContext({ text: '/delete_client DOES-NOT-EXIST' });
    await deleteClientCommand(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Customer not found'));
  });

  it('includes keyboard with confirm callback', async () => {
    vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
    const customer = customerRepository.create({
      clientId: 'KB-TEST-001',
      name: 'KB Customer',
      monitorType: 'icmp',
      pingHost: '192.168.1.1',
      enabled: true,
    });

    const ctx = createMockContext({ text: '/delete_client KB-TEST-001' });
    await deleteClientCommand(ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const keyboard = ctx.reply.mock.calls[0][1].reply_markup;
    expect(keyboard.inline_keyboard[0][0].callback_data).toMatch(/^delete_confirm:[a-f0-9-]+$/);
    expect(keyboard.inline_keyboard[0][1].callback_data).toMatch(/^delete_cancel:[a-f0-9-]+$/);
  });

  it('does not create pending session if customer not found', async () => {
    vi.spyOn(accessService, 'canManageCustomers').mockReturnValue(true);
    const ctx = createMockContext({ text: '/delete_client NOT-FOUND' });
    await deleteClientCommand(ctx);

    const pendingKeys = Array.from((pendingDeleteStore as any).store.keys());
    expect(pendingKeys.length).toBe(0);
  });
});
