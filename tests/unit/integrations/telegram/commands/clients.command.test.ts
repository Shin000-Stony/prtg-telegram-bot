import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfigForTesting } from '@/config/env';
import { resetDatabaseForTesting } from '@/infrastructure/database/database';
import { resetMigrationsForTesting, runMigrations } from '@/infrastructure/database/migration-runner';
import { clientsCommand, extractClientsKeyword } from '@/integrations/telegram/commands/clients.command';
import { clientsPaginationStore } from '@/modules/groups/clients-pagination.store';
import { accessService } from '@/modules/groups/access.service';
import { customerService } from '@/modules/customers/customer.service';
import { customerRepository } from '@/modules/customers/customer.repository';
import { groupRepository } from '@/modules/groups/group.repository';
import { mappingRepository } from '@/modules/mapping/mapping.repository';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const adminId = '123456789';
const globalGroupId = '-1001234567890';
const ordinaryGroupId = '-100999999999';

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
    vi.stubEnv('TELEGRAM_ADMIN_IDS', adminId);
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', globalGroupId);
    vi.stubEnv('DATABASE_PATH', testDbPath);
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
    resetDatabaseForTesting();
    runMigrations();
    clientsPaginationStore.cleanup();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
    clientsPaginationStore.cleanup();
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
      userId: overrides.userId || adminId,
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

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('ADM-1');
      expect(callArgs).toContain('Admin Customer 1');
      expect(callArgs).toContain('ADM-2');
      expect(callArgs).toContain('Admin Customer 2');
    });

    it('shows empty state when no customers exist', async () => {
      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('No visible customers found');
    });
  });

  describe('GLOBAL GROUP ADMIN', () => {
    it('returns all customers', async () => {
      customerService.create({ clientId: 'GG-ADM-1', name: 'Global Admin Cust', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: adminId, chatId: globalGroupId, chatType: 'supergroup' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('GG-ADM-1');
    });
  });

  describe('GLOBAL GROUP NON-ADMIN', () => {
    it('returns all customers read-only', async () => {
      customerService.create({ clientId: 'GG-NA-1', name: 'Global Non-Admin Cust', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: '999999999', chatId: globalGroupId, chatType: 'supergroup' });
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
      groupRepository.upsert(ordinaryGroupId, 'Ord Group');
      groupRepository.assignCustomer({ groupChatId: ordinaryGroupId, customerId: c1.id, canView: true, receiveAlerts: false });

      const ctx = createMockContext({ userId: '999999999', chatId: ordinaryGroupId, chatType: 'group' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('ORD-1');
      expect(callArgs).not.toContain('ORD-2');
    });

    it('returns empty state when no assigned customers', async () => {
      groupRepository.upsert(ordinaryGroupId, 'Ord Group No Access');
      const ctx = createMockContext({ userId: '999999999', chatId: ordinaryGroupId, chatType: 'group' });
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

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('FMT-1');
      expect(callArgs).not.toMatch(/ID\s*:\s*\d+/);
    });

    it('does not contain raw null/undefined', async () => {
      customerService.create({ clientId: 'FMT-2', name: 'No Null', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('null');
      expect(callArgs).not.toContain('undefined');
    });

    it('shows footer with details and search hints', async () => {
      customerService.create({ clientId: 'FT-1', name: 'Test', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true });

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('View details:');
      expect(callArgs).toContain('<b>/client</b>');
      expect(callArgs).toContain('<code>&lt;client_id&gt;</code>');
      expect(callArgs).toContain('<b>/clients</b>');
      expect(callArgs).toContain('<code>&lt;keyword&gt;</code>');
    });
  });

  describe('effective status display', () => {
    it('shows UNMAPPED status for PRTG customer without mapping', async () => {
      customerService.create({ clientId: 'UNM-1', name: 'Unmapped Customer', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('UNMAPPED');
      expect(callArgs).toContain('Mapping: Unmapped');
    });

    it('shows DISABLED status for disabled customer', async () => {
      customerService.create({ clientId: 'DIS-1', name: 'Disabled Customer', monitorType: 'prtg', pingHost: null, enabled: false });

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('DISABLED');
      expect(callArgs).toContain('Monitoring: Disabled');
    });

    it('shows PIC-MANAGED status for PIC customer', async () => {
      customerService.create({ clientId: 'PIC-1', name: 'PIC Customer', monitorType: 'pic', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('PIC-managed');
      expect(callArgs).not.toContain('Mapping:');
    });

    it('shows NOT CHECKED for ICMP customer', async () => {
      customerService.create({ clientId: 'ICM-1', name: 'ICMP Customer', monitorType: 'icmp', pingHost: '10.0.0.1', enabled: true });

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('NOT CHECKED');
      expect(callArgs).not.toContain('Mapping:');
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

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
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

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
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

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('DISABLED');
      expect(callArgs).toContain('#13999');
    });
  });

  describe('pagination', () => {
    const PAGE_SIZE = 8;

    function createCustomers(count: number, prefix: string = 'c') {
      for (let i = 0; i < count; i++) {
        customerService.create({
          clientId: `${prefix}-${String(i + 1).padStart(3, '0')}`,
          name: `Customer ${i + 1}`,
          monitorType: 'prtg',
          pingHost: null,
          enabled: true,
        });
      }
    }

    it('shows page count and range for <=8 customers', async () => {
      createCustomers(5);
      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Showing 1–5 of 5');
      expect(callArgs).toContain('Page 1/1');
    });

    it('shows first page with 8 items for 123 customers', async () => {
      createCustomers(123);
      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Showing 1–8 of 123');
      expect(callArgs).toContain('Page 1/16');
      expect(callArgs).not.toContain('◀ Previous');
    });

    it('includes keyboard with Next button on first page', async () => {
      createCustomers(123);
      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const keyboard = ctx.reply.mock.calls[0][1]?.reply_markup;
      expect(keyboard).toBeDefined();
      expect(keyboard.inline_keyboard.length).toBe(1);
      expect(keyboard.inline_keyboard[0][0].text).toBe('Next ▶');
    });

    it('no keyboard when single page', async () => {
      createCustomers(5);
      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const keyboard = ctx.reply.mock.calls[0][1]?.reply_markup;
      expect(keyboard.inline_keyboard.length).toBe(0);
    });

    it('footer shows correct count and total', async () => {
      createCustomers(123);
      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toMatch(/Showing 1–8 of 123/);
      expect(callArgs).toMatch(/Page 1\/16/);
    });
  });

  describe('keyword extraction', () => {
    it('extracts single-word keyword', () => {
      expect(extractClientsKeyword('/clients anugrah')).toBe('anugrah');
    });

    it('extracts multi-word keyword', () => {
      expect(extractClientsKeyword('/clients anugrah prasetyo')).toBe('anugrah prasetyo');
    });

    it('returns null for no keyword', () => {
      expect(extractClientsKeyword('/clients')).toBe(null);
    });

    it('returns null for only-whitespace keyword', () => {
      expect(extractClientsKeyword('/clients   ')).toBe(null);
    });
  });

  describe('search behavior', () => {
    const PAGE_SIZE = 8;

    beforeEach(() => {
      for (let i = 0; i < 10; i++) {
        customerService.create({
          clientId: `anug-${i}`,
          name: `Anugrah Customer ${i}`,
          monitorType: 'prtg',
          pingHost: null,
          enabled: true,
        });
      }
      for (let i = 0; i < 5; i++) {
        customerService.create({
          clientId: `other-${i}`,
          name: `Budi Customer ${i}`,
          monitorType: 'prtg',
          pingHost: null,
          enabled: true,
        });
      }
    });

    it('search by partial name returns matching customers', async () => {
      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients anugrah' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('<b>Customers</b>');
      expect(callArgs).toContain('Search: <code>anugrah</code>');
      expect(callArgs).toContain('anug-0');
      expect(callArgs).not.toContain('other-0');
    });

    it('search is case-insensitive', async () => {
      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients ANUGRAH' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('anug-0');
    });

    it('search by partial client_id', async () => {
      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients anug-5' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('anug-5');
    });

    it('search with numeric keyword is treated as client_id search', async () => {
      customerService.create({ clientId: '123', name: 'Numeric ID', monitorType: 'prtg', pingHost: null, enabled: true });
      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients 123' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('123');
    });

    it('search with multi-word keyword containing spaces', async () => {
      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients Anugrah Customer' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('anug-0');
      expect(callArgs).not.toContain('other-0');
    });

    it('empty search returns no matching message', async () => {
      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients nonexistent' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('No customers match your search');
    });
  });

  describe('special characters in search', () => {
    it('handles % in keyword safely (no wildcard injection)', async () => {
      customerService.create({ clientId: 'TEST-1', name: '100% Complete', monitorType: 'prtg', pingHost: null, enabled: true });
      customerService.create({ clientId: 'TEST-2', name: 'Half Complete', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients 100%' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('TEST-1');
      expect(callArgs).not.toContain('TEST-2');
      expect(callArgs).toContain('100% Complete');
    });

    it('handles _ in keyword safely', async () => {
      customerService.create({ clientId: 'TEST_UNDER', name: 'Test Under', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients under' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('TEST_UNDER');
    });

    it('handles quote characters safely', async () => {
      customerService.create({ clientId: 'Q-1', name: 'Test "Quote" Name', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients "Quote"' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Q-1');
    });

    it('handles very long names without crashing', async () => {
      const longName = 'A'.repeat(195);
      customerService.create({ clientId: 'LONG-1', name: longName, monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs.length).toBeLessThanOrEqual(4096);
    });
  });

  describe('Separated visual layout', () => {
    it('uses separator between customer blocks', async () => {
      customerService.create({ clientId: 'SEP-1', name: 'First Customer', monitorType: 'prtg', pingHost: null, enabled: true });
      customerService.create({ clientId: 'SEP-2', name: 'Second Customer', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('────────');
    });

    it('shows "not in use" for disabled PRTG customer with mapping', async () => {
      const customer = customerService.create({ clientId: 'DIS-USE', name: 'Disabled Mapped', monitorType: 'prtg', pingHost: null, enabled: false });
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 13999,
        prtgDeviceName: 'Dev',
        prtgSensorName: 'Sensor',
        mappingMethod: 'manual',
        confidence: 0.95,
        verified: true,
        mappedByTelegramId: null,
      });

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('#13999');
      expect(callArgs).toContain('Verified (not in use)');
    });

    it('shows unverified (not in use) for disabled unverified mapping', async () => {
      const customer = customerService.create({ clientId: 'DIS-UNV', name: 'Disabled Unverified', monitorType: 'prtg', pingHost: null, enabled: false });
      mappingRepository.create({
        customerId: customer.id,
        prtgObjectId: 14000,
        prtgDeviceName: 'Dev',
        prtgSensorName: 'Sensor',
        mappingMethod: 'auto',
        confidence: 0.8,
        verified: false,
        mappedByTelegramId: 'user1',
      });

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Unverified (not in use)');
    });

    it('search header uses code tags for keyword', async () => {
      customerService.create({ clientId: 'SRCH-1', name: 'Test Customer', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients test' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('Search: <code>test</code>');
    });

    it('search with HTML special chars in keyword is escaped', async () => {
      customerService.create({ clientId: 'HTML-1', name: 'Test &amp; Co', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients &amp; Co' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('&amp;');
      expect(callArgs).not.toMatch(/Search: <code>&(?![a-z])/);
    });

    it('empty search result message identical regardless of existence', async () => {
      const ctx = createMockContext({
        userId: adminId,
        chatId: '123456789',
        chatType: 'private',
        message: { text: '/clients nonexistent' },
      });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('No customers match your search');
      expect(callArgs).toContain('Try a shorter keyword or check the Client ID');
      expect(callArgs).toContain('All customers: <b>/clients</b>');
    });

    it('uses footer with View details and Search', async () => {
      customerService.create({ clientId: 'FT-2', name: 'Footer Test', monitorType: 'prtg', pingHost: null, enabled: true });

      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).toContain('View details:');
      expect(callArgs).toContain('<b>/client</b>');
      expect(callArgs).toContain('<code>&lt;client_id&gt;</code>');
      expect(callArgs).toContain('Search:');
      expect(callArgs).toContain('<b>/clients</b>');
      expect(callArgs).toContain('<code>&lt;keyword&gt;</code>');
    });

    it('does not contain 📋 emoji in Customers header', async () => {
      const ctx = createMockContext({ userId: adminId, chatId: '123456789', chatType: 'private' });
      await clientsCommand(ctx);

      const callArgs = ctx.reply.mock.calls[0][0];
      expect(callArgs).not.toContain('📋');
      expect(callArgs).toContain('<b>Customers</b>');
    });
  });
});
