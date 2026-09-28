import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { clientsCommand } from '@/integrations/telegram/commands/clients.command';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('/clients command', () => {
  let testDir: string;
  let testDbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'prtg-test-clients-'));
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
      message: overrides.message || { text: '/clients' },
      reply,
      ...overrides,
    } as any;
  }

  describe('PRIVATE ADMIN', () => {
    it('returns all customers', async () => {
      customerService.create({ clientId: 'ADM-1', name: 'Admin Customer 1', monitorType: 'prtg', pingHost: null, enabled: true });
      customerService.create({ clientId: 'ADM-2', name: 'Admin Customer 2', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('ADM-1');
      expect(callArgs).toContain('Admin Customer 1');
      expect(callArgs).toContain('ADM-2');
      expect(callArgs).toContain('Admin Customer 2');
    });

    it('shows empty state when no customers exist', async () => {
      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('No visible customers found');
    });
  });

  describe('GLOBAL GROUP ADMIN', () => {
    it('returns all customers', async () => {
      customerService.create({ clientId: 'GG-ADM-1', name: 'Global Admin Cust', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '-1001234567890', chatType: 'supergroup' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('GG-ADM-1');
    });
  });

  describe('GLOBAL GROUP NON-ADMIN', () => {
    it('returns all customers read-only', async () => {
      customerService.create({ clientId: 'GG-NA-1', name: 'Global Non-Admin Cust', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '999999999', chatId: '-1001234567890', chatType: 'supergroup' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('GG-NA-1');
    });
  });

  describe('REGISTERED ORDINARY GROUP', () => {
    it('returns assigned customers only', async () => {
      const c1 = customerService.create({ clientId: 'ORD-1', name: 'Assigned', monitorType: 'prtg', pingHost: null, enabled: true });
      const c2 = customerService.create({ clientId: 'ORD-2', name: 'Not Assigned', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true });
      groupRepository.upsert('-100999999999', 'Ord Group');
      groupRepository.assignCustomer({ groupChatId: '-100999999999', customerId: c1.id, canView: true, receiveAlerts: false });

      const ctx = createMockContext({ userId: '999999999', chatId: '-100999999999', chatType: 'group' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('ORD-1');
      expect(callArgs).not.toContain('ORD-2');
    });

    it('returns empty state when no assigned customers', async () => {
      groupRepository.upsert('-100999999999', 'Ord Group No Access');
      const ctx = createMockContext({ userId: '999999999', chatId: '-100999999999', chatType: 'group' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('No visible customers found');
    });
  });

  describe('UNREGISTERED GROUP', () => {
    it('denied/no customer data', async () => {
      customerService.create({ clientId: 'UNREG-1', name: 'Should Not See', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '999999999', chatId: '-100888888888', chatType: 'group' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toMatch(/akses ditolak|Access denied/i);
    });
  });

  describe('NON-ADMIN PRIVATE', () => {
    it('denied/no customer data', async () => {
      customerService.create({ clientId: 'PRIV-1', name: 'Should Not See', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '999999999', chatId: '999999999', chatType: 'private' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toMatch(/akses ditolak|Access denied/i);
    });
  });

  describe('formatting', () => {
    it('never shows internal DB id', async () => {
      customerService.create({ clientId: 'FMT-1', name: 'Format Test', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('FMT-1');
      expect(callArgs).not.toMatch(/ID\s*:\s*\d+/);
    });

    it('does not contain raw null/undefined', async () => {
      customerService.create({ clientId: 'FMT-2', name: 'No Null', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('null');
      expect(callArgs).not.toContain('undefined');
    });
  });

  describe('effective status display', () => {
    it('shows UNMAPPED status for PRTG customer without mapping', async () => {
      customerService.create({ clientId: 'UNM-1', name: 'Unmapped Customer', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('UNMAPPED');
      expect(callArgs).toContain('Mapping: Unmapped');
    });

    it('shows DISABLED status for disabled customer', async () => {
      customerService.create({ clientId: 'DIS-1', name: 'Disabled Customer', monitorType: 'prtg', pingHost: null, enabled: false });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('DISABLED');
      expect(callArgs).toContain('Monitoring: Disabled');
    });

    it('shows PIC-MANAGED status for PIC customer', async () => {
      customerService.create({ clientId: 'PIC-1', name: 'PIC Customer', monitorType: 'pic', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('PIC-managed');
      expect(callArgs).not.toContain('Mapping:');
    });

    it('shows NOT CHECKED for ICMP customer', async () => {
      customerService.create({ clientId: 'ICM-1', name: 'ICMP Customer', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('NOT CHECKED');
      expect(callArgs).not.toContain('Mapping:');
    });

    it('shows footer with /client placeholder escaped', async () => {
      customerService.create({ clientId: 'FT-1', name: 'Test', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('View details: /client &lt;client_id&gt;');
    });
  });

  describe('mapping display', () => {
    it('shows mapped PRTG customer with objectId and verified status', async () => {
      const customer = customerService.create({ clientId: 'MAP-1', name: 'Mapped Customer', monitorType: 'prtg', pingHost: null, enabled: true });
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 13862,
        prtgDeviceName: 'Device1',
        prtgSensorName: 'Sensor1',
        mappingMethod: 'manual',
        confidence: 0.9,
        verified: true,
        mappedByTelegramId: null,
      });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('#13862');
      expect(callArgs).toContain('Verified');
    });

    it('shows unverified mapping', async () => {
      const customer = customerService.create({ clientId: 'MAP-2', name: 'Unverified Customer', monitorType: 'prtg', pingHost: null, enabled: true });
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 13880,
        prtgDeviceName: 'Device2',
        prtgSensorName: 'Sensor2',
        mappingMethod: 'auto',
        confidence: 0.8,
        verified: false,
        mappedByTelegramId: 'user1',
      });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('#13880');
      expect(callArgs).toContain('Unverified');
    });

    it('shows mapping with not-in-use indicator for disabled customer', async () => {
      const customer = customerService.create({ clientId: 'DIS-MAP', name: 'Disabled Mapped', monitorType: 'prtg', pingHost: null, enabled: false });
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 13999,
        prtgDeviceName: 'Device3',
        prtgSensorName: 'Sensor3',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: null,
      });

      const ctx = createMockContext({ userId: '123456789', chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('DISABLED');
      expect(callArgs).toContain('#13999');
    });
  });
});