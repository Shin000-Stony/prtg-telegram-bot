import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { clientCommand } from '@/integrations/telegram/commands/client.command';
import { accessService } from '@/modules/groups/access.service';
import { groupService } from '@/modules/groups/group.service';
import { customerService } from '@/modules/customers/customer.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import { mappingService } from '@/modules/mapping/mapping.service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/client command', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-client-'));
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
    runMigrations();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  function createMockContext(overrides: Partial<{
    userId: string;
    chatId: string;
    chatType: string;
    message: { text: string };
    reply: ReturnType<typeof vi.fn>;
  }> = {}) {
    const reply = vi.fn();
    return {
      userId: overrides.userId || 'user1',
      chatId: overrides.chatId || '123456789',
      chatType: overrides.chatType || 'private',
      message: overrides.message || { text: '/client CLI-1' },
      reply,
      ...overrides,
    } as any;
  }

  describe('visible client_id -> displays detail', () => {
    it('shows PRTG customer detail', async () => {
      const customer = customerService.create({ clientId: 'CLI-1', name: 'Test PRTG', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/client CLI-1' } });
      await clientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('CLI-1');
      expect(callArgs).toContain('Test PRTG');
      expect(callArgs).toContain('PRTG');
      expect(callArgs).toContain('Monitoring : Enabled');
      expect(callArgs).toContain('Not connected');
      expect(callArgs).not.toContain('Status :');
    });

    it('shows ICMP customer detail with ping host', async () => {
      customerService.create({ clientId: 'CLI-2', name: 'Test ICMP', monitorType: 'icmp', pingHost: '10.10.10.10', enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/client CLI-2' } });
      await clientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('CLI-2');
      expect(callArgs).toContain('10.10.10.10');
    });
  });

  describe('unknown client_id -> not found', () => {
    it('returns not found for unknown client', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/client UNKNOWN' } });
      await clientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Customer not found');
    });
  });

  describe('assigned ordinary-group customer -> visible', () => {
    it('shows customer for registered group with access', async () => {
      const customer = customerService.create({ clientId: 'CLI-ORD', name: 'Ord Customer', monitorType: 'prtg', pingHost: null, enabled: true });
      groupRepository.upsert('-100999999999', 'Ord Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: customer.id, canView: true, receiveAlerts: false });

      const ctx = createMockContext({ userId: '999999999', chatId: '-100999999999', chatType: 'group', message: { text: '/client CLI-ORD' } });
      await clientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('CLI-ORD');
      expect(callArgs).toContain('Ord Customer');
    });
  });

  describe('non-assigned ordinary-group customer -> denied', () => {
    it('denies access to non-assigned customer', async () => {
      customerService.create({ clientId: 'CLI-NO-ACCESS', name: 'No Access', monitorType: 'prtg', pingHost: null, enabled: true });
      groupRepository.upsert('-100999999999', 'Ord Group');

      const ctx = createMockContext({ userId: '999999999', chatId: '-100999999999', chatType: 'group', message: { text: '/client CLI-NO-ACCESS' } });
      await clientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Access denied');
    });
  });

  describe('Global Group -> arbitrary existing customer visible', () => {
    it('shows any customer for global group member', async () => {
      customerService.create({ clientId: 'CLI-GLOBAL', name: 'Global Customer', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup', message: { text: '/client CLI-GLOBAL' } });
      await clientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('CLI-GLOBAL');
    });
  });

  describe('lookup uses client_id, not internal customer PK', () => {
    it('looks up by client_id not internal id', async () => {
      const customer = customerService.create({ clientId: 'CLI-LOOKUP', name: 'Lookup Test', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/client CLI-LOOKUP' } });
      await clientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('CLI-LOOKUP');
      expect(callArgs).not.toMatch(/Client ID : <code>\d+/);
      expect(callArgs).not.toMatch(/^\d+\./);
    });
  });

  describe('unmapped PRTG customer shown safely as unmapped', () => {
    it('shows Not required for unmapped PRTG customer', async () => {
      customerService.create({ clientId: 'CLI-UNMAPPED', name: 'Unmapped PRTG', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/client CLI-UNMAPPED' } });
      await clientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('CLI-UNMAPPED');
      expect(callArgs).toContain('Not connected');
    });

    it('does not expose internal DB id', async () => {
      const customer = customerService.create({ clientId: 'CLI-NO-ID', name: 'No ID Leak', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/client CLI-NO-ID' } });
      await clientCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toMatch(/ID\s*:\s*\d+/);
    });

    it('does not contain raw null/undefined', async () => {
      customerService.create({ clientId: 'CLI-NULL', name: 'Null Check', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/client CLI-NULL' } });
      await clientCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('null');
      expect(callArgs).not.toContain('undefined');
    });
  });

  describe('missing argument', () => {
    it('shows usage when no client_id provided', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private', message: { text: '/client' } });
      await clientCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Usage: <b>/client</b> <code>&lt;client_id&gt;</code>');
    });
  });

  // Regression: R1 - scope none rejects before registry lookup; hidden and nonexistent get same response
  describe('regression: existence leakage prevention', () => {
    it('scope none rejects before registry lookup (zero lookups)', async () => {
      const customer = customerService.create({ clientId: 'EXISTING-CLIENT', name: 'Test', monitorType: 'prtg', pingHost: null, enabled: true });
      
      // Unregistered group - scope none
      const ctx1 = createMockContext({ userId: '456', chatId: '-100111111800', chatType: 'supergroup', message: { text: '/client EXISTING-CLIENT' } });
      await clientCommand(ctx1);
      
      // Should deny without doing customer lookup
      expect(ctx1.reply).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
      
      // Missing client should get same response
      const ctx2 = createMockContext({ userId: '456', chatId: '-100111111800', chatType: 'supergroup', message: { text: '/client NONEXISTENT' } });
      await clientCommand(ctx2);
      
      expect(ctx2.reply).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    });

    it('assigned scope: hidden and nonexistent get same response', async () => {
      const customer = customerService.create({ clientId: 'HIDDEN-CLIENT', name: 'Hidden', monitorType: 'prtg', pingHost: null, enabled: true });
      groupService.register('-100111111801', 'Test Group');
      // Create access with can_view=false (hidden)
      groupRepository.assignCustomer({ groupChatId: '-100111111801', customerId: customer.id, canView: false, receiveAlerts: true });
      
      // Hidden customer
      const ctx1 = createMockContext({ userId: '456', chatId: '-100111111801', chatType: 'supergroup', message: { text: '/client HIDDEN-CLIENT' } });
      await clientCommand(ctx1);
      
      // Missing customer in same group
      const ctx2 = createMockContext({ userId: '456', chatId: '-100111111801', chatType: 'supergroup', message: { text: '/client NONEXISTENT' } });
      await clientCommand(ctx2);
      
      // Both should get same "Access denied" response
      const reply1 = ctx1.reply.mock.calls[0][0];
      const reply2 = ctx2.reply.mock.calls[0][0];
      expect(reply1).toBe(reply2);
      expect(reply1).toContain('Access denied');
    });
  });
});