import { vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'development');
vi.stubEnv('LOG_LEVEL', 'info');
vi.stubEnv('TZ', 'Asia/Makassar');
vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test_token');
vi.stubEnv('TELEGRAM_ADMIN_IDS', 'admin1,admin2');
vi.stubEnv('TELEGRAM_GLOBAL_GROUP_ID', '-1001234567890');
vi.stubEnv('DATABASE_PATH', '/home/shin/Documents/Monitoring_PRTG/prtg_telegram_bot/data/test.db');
vi.stubEnv('PRTG_BASE_URL', '');
vi.stubEnv('PRTG_USERNAME', '');
vi.stubEnv('PRTG_PASSHASH', '');
vi.stubEnv('PRTG_TLS_REJECT_UNAUTHORIZED', 'false');