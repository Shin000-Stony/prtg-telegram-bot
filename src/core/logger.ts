import pino from 'pino';
import { getConfig } from '../config/env';

let loggerInstance: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (loggerInstance) {
    return loggerInstance;
  }

  const config = getConfig();

  const transport = config.NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

  loggerInstance = pino({
    level: config.LOG_LEVEL,
    transport,
    base: {
      service: 'prtg-telegram-bot',
    },
  });

  return loggerInstance;
}

export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}

export function resetLoggerForTesting(): void {
  loggerInstance = null;
}