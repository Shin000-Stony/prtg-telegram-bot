import https from 'node:https';
import type { PrtgClientConfig, PrtgTable } from './prtg.types';
import { PrtgSensorRawSchema, PrtgDeviceRawSchema } from './prtg.types';
import type { PrtgPageResult } from './prtg.types';
import { AppError } from '../../core/errors/app-error';
import { getLogger } from '../../core/logger';

const logger = getLogger().child({ module: 'PrtgTransport' });

const DEFAULT_PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_PAGES_PER_FETCH = 100;

export class HttpsPrtgTransport {
  readonly pageSize = DEFAULT_PAGE_SIZE;
  readonly timeoutMs = REQUEST_TIMEOUT_MS;
  readonly maxBodyBytes = MAX_BODY_BYTES;
  readonly maxPagesPerFetch = MAX_PAGES_PER_FETCH;

  private readonly config: PrtgClientConfig;
  private readonly httpsModule: typeof https;

  constructor(config: PrtgClientConfig, httpsModule: typeof https = https) {
    this.config = config;
    this.httpsModule = httpsModule;
  }

  async fetchPage(table: PrtgTable, start: number, count: number, signal?: AbortSignal): Promise<PrtgPageResult> {
    const requestStart = Date.now();
    logger.info({ table, start, count, elapsedMs: 0, phase: 'request_start' }, 'PRTG page request');

    const url = this.buildUrl(table, start, Math.min(count, this.pageSize));

    let responseText: string;
    try {
      responseText = await this.request(url, signal, table, start, count);
      logger.info({ table, start, count, elapsedMs: Date.now() - requestStart, phase: 'request_end', outcome: 'success' }, 'PRTG page request completed');
    } catch (error) {
      const elapsed = Date.now() - requestStart;
      logger.warn({ table, start, count, elapsedMs: elapsed, phase: 'request_end', outcome: 'failed', errType: error instanceof Error ? error.constructor.name : typeof error }, 'PRTG page request failed');
      throw error;
    }

    try {
      const parsed = JSON.parse(responseText) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn({ table, start }, 'PRTG response was not a JSON object envelope');
        throw AppError.external('PRTG API returned a non-object response', { table, start });
      }
      const envelope = parsed as Record<string, unknown>;
      const tableArray = envelope[table];
      if (!Array.isArray(tableArray)) {
        logger.warn({ table, start }, 'PRTG response missing expected table array in envelope');
        throw AppError.external(`PRTG API response did not contain expected ${table} array`, { table, start });
      }

      const total = parseTotal(envelope);

      const arr = tableArray;
      if (table === 'sensors') {
        return {
          rows: arr.map((item, idx) => {
            const result = PrtgSensorRawSchema.safeParse(item);
            if (!result.success) {
              logger.warn({ table, start, index: idx, issues: result.error.issues.map(i => i.path.join('.')) }, 'Invalid PRTG sensor row');
              throw AppError.external('PRTG API sensor row malformed', { table, start, index: idx });
            }
            return result.data;
          }),
          total,
        };
      }
      return {
        rows: arr.map((item, idx) => {
          const result = PrtgDeviceRawSchema.safeParse(item);
          if (!result.success) {
            logger.warn({ table, start, index: idx, issues: result.error.issues.map(i => i.path.join('.')) }, 'Invalid PRTG device row');
            throw AppError.external('PRTG API device row malformed', { table, start, index: idx });
          }
          return result.data;
        }),
        total,
      };
    } catch (error) {
      if (isAppError(error) && ['EXTERNAL_ERROR', 'NETWORK_ERROR'].includes(error.code)) {
        throw error;
      }
      logger.warn({ table, start, errType: error instanceof Error ? error.constructor.name : typeof error }, 'PRTG JSON parse failed');
      throw AppError.external('PRTG API returned an unparseable response', { table, start });
    }
  }

  private buildUrl(table: PrtgTable, start: number, count: number): URL {
    const base = new URL(this.config.baseUrl.replace(/\/+$/, ''));
    base.pathname = base.pathname.replace(/\/+$/, '') + '/api/table.json';
    base.searchParams.set('content', table);
    base.searchParams.set('columns', columnsFor(table));
    base.searchParams.set('start', String(start));
    base.searchParams.set('count', String(count));
    base.searchParams.set('username', this.config.username);
    base.searchParams.set('passhash', this.config.passhash);
    base.searchParams.set('output', 'json');
    base.searchParams.set('id', '0');
    base.searchParams.set('sortby', 'objid');
    return base;
  }

  private request(url: URL, signal: AbortSignal | undefined, table: PrtgTable, start: number, count: number): Promise<string> {
    const requestStart = Date.now();
    let phase = 'connecting';

    return new Promise<string>((resolve, reject) => {
      let body = '';
      let bodyBytes = 0;
      let settled = false;

      const options: https.RequestOptions = {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: { Accept: 'application/json' },
        rejectUnauthorized: this.config.rejectUnauthorized ? undefined : false,
        timeout: this.timeoutMs,
      };

      const cleanup = () => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        req.destroy();
        cleanup();
        logger.warn({ table, elapsedMs: Date.now() - requestStart, phase }, 'PRTG request aborted');
        reject(AppError.external('PRTG API request aborted', { table }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy(new Error('timeout'));
        cleanup();
        logger.warn({ table, start, count, elapsedMs: Date.now() - requestStart, phase, timeoutMs: this.timeoutMs }, 'PRTG API request timed out');
        reject(AppError.external('PRTG API request timed out', { table }));
      }, this.timeoutMs);

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (isAppError(error)) {
          reject(error);
          return;
        }
        const err = error as NodeJS.ErrnoException;
        const isAbort = err.code === 'ABORTE' || err.name === 'AbortError' || /abort/i.test(err.message || '');
        logger.warn({ table, elapsedMs: Date.now() - requestStart, phase }, 'PRTG request failed');
        reject(
          isAbort
            ? AppError.external('PRTG API request aborted', { table })
            : AppError.external('PRTG API request failed', { table }),
        );
      };

      const req = this.httpsModule.request(options, (res) => {
        phase = 'connected';
        if (res.statusCode && res.statusCode >= 300) {
          res.resume();
          logger.warn({ statusCode: res.statusCode }, 'PRTG request returned non-OK status');
          fail(AppError.external('PRTG API request failed', { httpStatus: res.statusCode, table, redirect: Boolean(res.headers.location) }));
          return;
        }
        phase = 'response_headers';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          bodyBytes += Buffer.byteLength(chunk);
          if (bodyBytes > this.maxBodyBytes) {
            req.destroy();
            fail(AppError.external('PRTG API response exceeded maximum allowed size', { table }));
            return;
          }
          body += chunk;
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          resolve(body);
        });
      });

      req.on('error', fail);
      req.on('socket', (socket: { on: (event: string, cb: () => void) => void; connect: boolean; remoteAddress?: string }) => {
        if (!socket.connect) {
          socket.on('connect', () => { phase = 'connected'; });
        } else {
          phase = 'connected';
        }
        socket.on('secureConnect', () => { phase = 'tls_complete'; });
      });
      req.end();
    });
  }
}

function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

function columnsFor(table: PrtgTable): string {
  if (table === 'sensors') {
    return 'objid,device,sensor,type,status_raw,status,statusmessage,lastvalue,lastup,lastdown,host';
  }
  return 'objid,device,host,status_raw,status,name';
}

function parseTotal(envelope: Record<string, unknown>): number | null {
  const raw = envelope.treesize;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
    return null;
  }
  return num;
}