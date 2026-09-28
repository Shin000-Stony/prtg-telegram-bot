import { z } from 'zod';
import { AppError } from '../core/errors/app-error';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TZ: z.string().default('Asia/Makassar'),

  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_ADMIN_IDS: z.string().transform((val) =>
    val.split(',').map((id) => id.trim()).filter(Boolean)
  ).default(''),
  TELEGRAM_GLOBAL_GROUP_ID: z.string().optional(),

  DATABASE_PATH: z.string().default('/data/prtg_bot.db'),

  PRTG_BASE_URL: z.string().url().optional().or(z.literal('')),
  PRTG_USERNAME: z.string().optional().or(z.literal('')),
  PRTG_PASSHASH: z.string().optional().or(z.literal('')),
  PRTG_TLS_REJECT_UNAUTHORIZED: z.string().transform((val) => val === 'true').default('true'),

  MONITORING_ENABLED: z.string().transform((val) => val === 'true').default('false'),
  PRTG_POLL_INTERVAL_MS: z.coerce.number().int().min(10000).default(60000),
  ICMP_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(30000),
  ICMP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(10000).default(3000),
  ICMP_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),

  ALERTS_ENABLED: z.enum(['true', 'false']).transform((val) => val === 'true').default('false'),
  ALERT_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(1000),
  ALERT_MAX_EVENT_AGE_MS: z.coerce.number().int().min(60000).max(86400000).default(900000),
  ALERT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
});

export interface PrtgClientConfig {
  baseUrl: string;
  username: string;
  passhash: string;
  rejectUnauthorized: boolean;
}

const PRTG_PROVIDED = ['PRTG_BASE_URL', 'PRTG_USERNAME', 'PRTG_PASSHASH'] as const;
const PRTG_REQUIRED_COUNT = 3;

export function getPrtgConfig(): PrtgClientConfig | null {
  const env = getConfig();
  const provided = PRTG_PROVIDED.filter((key) => env[key] !== '' && env[key] !== undefined);

  if (provided.length === 0) {
    return null;
  }
  if (provided.length !== PRTG_REQUIRED_COUNT) {
    throw AppError.validation(
      'PRTG configuration is incomplete; provide all of PRTG_BASE_URL, PRTG_USERNAME, and PRTG_PASSHASH, or leave all empty',
    );
  }

  if (!env.PRTG_BASE_URL || !env.PRTG_USERNAME || !env.PRTG_PASSHASH) {
    throw AppError.validation(
      'PRTG configuration is incomplete; provide all of PRTG_BASE_URL, PRTG_USERNAME, and PRTG_PASSHASH, or leave all empty',
    );
  }

  let url: URL;
  try {
    url = new URL(env.PRTG_BASE_URL);
  } catch {
    throw AppError.validation('PRTG_BASE_URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw AppError.validation('PRTG_BASE_URL must use the https scheme');
  }
  if (url.username || url.password || url.searchParams.toString() || url.hash) {
    throw AppError.validation(
      'PRTG_BASE_URL must not contain credentials, query parameters, or fragments',
    );
  }

  return {
    baseUrl: url.toString(),
    username: env.PRTG_USERNAME,
    passhash: env.PRTG_PASSHASH,
    rejectUnauthorized: env.PRTG_TLS_REJECT_UNAUTHORIZED,
  };
}

export type EnvConfig = z.infer<typeof envSchema>;

let cachedConfig: EnvConfig | null = null;

export function getConfig(): EnvConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${errors}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}

export function resetConfigForTesting(): void {
  cachedConfig = null;
}