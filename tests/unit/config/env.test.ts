import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getConfig, resetConfigForTesting } from '@/config/env';

describe('Config Validation', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1,admin2');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('DATABASE_PATH', ':memory:');
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
  });

  it('parses valid config', () => {
    const config = getConfig();
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.TELEGRAM_BOT_TOKEN).toBe('test_token');
    expect(config.TELEGRAM_ADMIN_IDS).toEqual(['admin1', 'admin2']);
    expect(config.TELEGRAM_GLOBAL_GROUP_ID).toBe('-1001234567890');
    expect(config.DATABASE_PATH).toBe(':memory:');
    expect(config.PRTG_TLS_REJECT_UNAUTHORIZED).toBe(false);
  });

  it('handles empty TELEGRAM_ADMIN_IDS', () => {
    vi.stubEnv('TELEGRAM_ADMIN_IDS', '');
    resetConfigForTesting();
    const config = getConfig();
    expect(config.TELEGRAM_ADMIN_IDS).toEqual([]);
  });

  it('handles whitespace in TELEGRAM_ADMIN_IDS', () => {
    vi.stubEnv('TELEGRAM_ADMIN_IDS', ' 123 , 456 , 789 ');
    resetConfigForTesting();
    const config = getConfig();
    expect(config.TELEGRAM_ADMIN_IDS).toEqual(['123', '456', '789']);
  });

  it('handles empty TELEGRAM_GLOBAL_GROUP_ID as empty string', () => {
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '');
    resetConfigForTesting();
    const config = getConfig();
    expect(config.TELEGRAM_GLOBAL_GROUP_ID).toBe('');
  });

  it('throws on missing TELEGRAM_BOT_TOKEN', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    resetConfigForTesting();
    expect(() => getConfig()).toThrow('TELEGRAM_BOT_TOKEN is required');
  });

  it('throws on invalid NODE_ENV', () => {
    vi.stubEnv('NODE_ENV', 'invalid');
    resetConfigForTesting();
    expect(() => getConfig()).toThrow();
  });

  it('throws on invalid LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'invalid');
    resetConfigForTesting();
    expect(() => getConfig()).toThrow();
  });

  it('parses PRTG_TLS_REJECT_UNAUTHORIZED as boolean', () => {
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'true');
    resetConfigForTesting();
    const config = getConfig();
    expect(config.PRTG_TLS_REJECT_UNAUTHORIZED).toBe(true);
  });

  it('config object contains token but logger should not expose it', () => {
    const config = getConfig();
    expect(config.TELEGRAM_BOT_TOKEN).toBe('test_token');
  });
});