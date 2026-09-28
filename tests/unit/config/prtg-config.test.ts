import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getConfig, resetConfigForTesting, getPrtgConfig } from '@/config/env';
import { AppError } from '@/core/errors/app-error';

describe('getPrtgConfig', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('TZ', 'Asia/Makassar');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
    vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1,admin2');
    vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
    vi.stubEnv('DATABASE_PATH', ':memory:');
    resetConfigForTesting();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
  });

  it('returns null when no PRTG config provided', () => {
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'true');
    resetConfigForTesting();

    expect(getPrtgConfig()).toBeNull();
  });

  it('throws on partial config (only base URL)', () => {
    vi.stubEnv('PRTG_BASE_URL', 'https://prtg.example.com');
    vi.stubEnv('PRTG_USERNAME', '');
    vi.stubEnv('PRTG_PASSHASH', '');
    resetConfigForTesting();

    expect(() => getPrtgConfig()).toThrow('PRTG configuration is incomplete');
  });

  it('throws on partial config (only username)', () => {
    vi.stubEnv('PRTG_BASE_URL', '');
    vi.stubEnv('PRTG_USERNAME', 'user');
    vi.stubEnv('PRTG_PASSHASH', '');
    resetConfigForTesting();

    expect(() => getPrtgConfig()).toThrow('PRTG configuration is incomplete');
  });

  it('returns config when all three provided', () => {
    vi.stubEnv('PRTG_BASE_URL', 'https://prtg.example.com/api/');
    vi.stubEnv('PRTG_USERNAME', 'user123');
    vi.stubEnv('PRTG_PASSHASH', 'passhash456');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');
    resetConfigForTesting();

    const config = getPrtgConfig();
    expect(config).not.toBeNull();
    expect(config?.baseUrl).toBe('https://prtg.example.com/api/');
    expect(config?.username).toBe('user123');
    expect(config?.passhash).toBe('passhash456');
    expect(config?.rejectUnauthorized).toBe(false);
  });

  it('rejects base URL with credentials', () => {
    vi.stubEnv('PRTG_BASE_URL', 'https://user:pass@prtg.example.com');
    vi.stubEnv('PRTG_USERNAME', 'user');
    vi.stubEnv('PRTG_PASSHASH', 'pass');
    resetConfigForTesting();

    expect(() => getPrtgConfig()).toThrow('must not contain credentials');
  });

  it('rejects base URL with query parameters', () => {
    vi.stubEnv('PRTG_BASE_URL', 'https://prtg.example.com?foo=bar');
    vi.stubEnv('PRTG_USERNAME', 'user');
    vi.stubEnv('PRTG_PASSHASH', 'pass');
    resetConfigForTesting();

    expect(() => getPrtgConfig()).toThrow('must not contain');
  });

  it('rejects base URL with fragment', () => {
    vi.stubEnv('PRTG_BASE_URL', 'https://prtg.example.com#section');
    vi.stubEnv('PRTG_USERNAME', 'user');
    vi.stubEnv('PRTG_PASSHASH', 'pass');
    resetConfigForTesting();

    expect(() => getPrtgConfig()).toThrow('must not contain');
  });

  it('rejects non-HTTPS base URL', () => {
    vi.stubEnv('PRTG_BASE_URL', 'http://prtg.example.com');
    vi.stubEnv('PRTG_USERNAME', 'user');
    vi.stubEnv('PRTG_PASSHASH', 'pass');
    resetConfigForTesting();

    expect(() => getPrtgConfig()).toThrow('must use the https scheme');
  });

  it('rejects invalid URL', () => {
    vi.stubEnv('PRTG_BASE_URL', 'not-a-url');
    vi.stubEnv('PRTG_USERNAME', 'user');
    vi.stubEnv('PRTG_PASSHASH', 'pass');
    resetConfigForTesting();

    expect(() => getPrtgConfig()).toThrow('Invalid environment configuration');
  });

  it('defaults TLS rejectUnauthorized to true', () => {
    vi.stubEnv('PRTG_BASE_URL', 'https://prtg.example.com');
    vi.stubEnv('PRTG_USERNAME', 'user');
    vi.stubEnv('PRTG_PASSHASH', 'pass');
    vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'true');
    resetConfigForTesting();

    const config = getPrtgConfig();
    expect(config?.rejectUnauthorized).toBe(true);
  });
});