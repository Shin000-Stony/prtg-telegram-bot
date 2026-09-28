import { spawn, type SpawnOptions } from 'child_process';
import { isIP } from 'net';
import { getLogger } from '@/core/logger';

const logger = getLogger().child({ module: 'IcmpAdapter' });

export interface IcmpResult {
  status: 'UP' | 'DOWN' | 'UNKNOWN';
  reason: string;
  rtt: number | null;
  attemptAt: number;
  completionAt: number;
}

export interface IcmpAdapterDeps {
  runPing: (host: string, timeoutMs: number, signal?: AbortSignal) => Promise<IcmpResult>;
  clock: () => number;
}

export interface IcmpChildDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => IcmpChildHandle;
  clock: () => number;
}

export interface IcmpChildHandle {
  on(event: 'close', cb: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', cb: (err: Error & { code?: string }) => void): this;
  stdout: { on(event: 'data', cb: (data: Buffer) => void): void } | null;
  stderr: { on(event: 'data', cb: (data: Buffer) => void): void } | null;
  kill(signal?: NodeJS.Signals): boolean;
  killCount?: number;
  removeAllListeners(): void;
}

const VALID_HOSTNAME_REGEX = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$/;

export function validateHost(host: string): { valid: boolean; reason: string } {
  if (!host || typeof host !== 'string') {
    return { valid: false, reason: 'empty_host' };
  }

  if (host.length > 253) {
    return { valid: false, reason: 'host_too_long' };
  }

  if (host.includes(' ')) {
    return { valid: false, reason: 'contains_whitespace' };
  }

  if (host.split('').some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    return { valid: false, reason: 'contains_control_characters' };
  }

  if (host.startsWith('-')) {
    return { valid: false, reason: 'option_injection' };
  }

  const trimmed = host.trim();
  if (trimmed.includes(' ') || trimmed.includes('\t')) {
    return { valid: false, reason: 'contains_whitespace' };
  }

  const ipType = isIP(trimmed);
  if (ipType > 0) {
    return { valid: true, reason: ipType === 4 ? 'ipv4' : 'ipv6' };
  }

  const labels = trimmed.split('.');
  for (const label of labels) {
    if (!label || label.length > 63) {
      return { valid: false, reason: 'invalid_label' };
    }
    if (!VALID_HOSTNAME_REGEX.test(label)) {
      return { valid: false, reason: 'invalid_hostname_format' };
    }
  }

  return { valid: true, reason: 'hostname' };
}

function parseRtt(stdout: string): number | null {
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    const match = line.match(/rtt min\/avg\/max\/mdev = [\d.]+ \/ ([\d.]+) \/ [\d.]+ \/ [\d.]+/);
    if (match) {
      const rtt = parseFloat(match[1]);
      if (!isNaN(rtt)) return rtt;
    }
  }
  return null;
}

function buildPingArgs(host: string, timeoutMs: number): string[] {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const deadlineSeconds = timeoutSeconds + 2;
  return ['-n', '-c', '1', '-W', String(timeoutSeconds), '-w', String(deadlineSeconds), host];
}

export function createIcmpPingRunner(deps?: IcmpChildDeps): (host: string, timeoutMs: number, signal?: AbortSignal) => Promise<IcmpResult> {
  const clock = deps?.clock ?? Date.now;
  const spawnFn = deps?.spawn ?? realSpawn;

  return (host: string, timeoutMs: number, signal?: AbortSignal): Promise<IcmpResult> => {
    const validation = validateHost(host);
    if (!validation.valid) {
      logger.warn({ host: '[invalid]' }, 'Host validation failed, skipping probe');
      const now = clock();
      return Promise.resolve({ status: 'UNKNOWN', reason: validation.reason, rtt: null, attemptAt: now, completionAt: now });
    }

    const attemptAt = clock();
    const args = buildPingArgs(host, timeoutMs);
    const processTimeoutMs = timeoutMs + 2000;

    return new Promise((resolve) => {
      let resolved = false;
      let _killCount = 0;

      if (signal?.aborted) {
        resolve({ status: 'UNKNOWN', reason: 'aborted', rtt: null, attemptAt, completionAt: clock() });
        return;
      }

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        killProc();
        cleanup();
        logger.warn({ host }, 'ICMP probe timed out');
        resolve({ status: 'UNKNOWN', reason: 'timeout', rtt: null, attemptAt, completionAt: clock() });
      }, processTimeoutMs);

      const abortHandler = () => {
        if (resolved) return;
        resolved = true;
        killProc();
        cleanup();
        logger.info({ host }, 'ICMP probe aborted');
        resolve({ status: 'UNKNOWN', reason: 'aborted', rtt: null, attemptAt, completionAt: clock() });
      };

      signal?.addEventListener('abort', abortHandler, { once: true });

      let proc: IcmpChildHandle | null = null;

      function killProc(): void {
        _killCount++;
        if (proc) {
          try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        }
      }

      function cleanup(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        // Note: we do NOT removeAllListeners here.
        // The error handler stays active to consume late errors (e.g. ABORT_ERR after kill).
        // The close handler will remove listeners after process termination.
      }

      try {
        proc = spawnFn('ping', args, {
          timeout: processTimeoutMs,
          maxBuffer: 64 * 1024,
          signal,
          stdio: ['ignore', 'pipe', 'pipe'],
          kill: (sig?: NodeJS.Signals) => {
            if (proc) { _killCount++; }
            return proc ? proc.kill(sig) : false;
          },
          removeAllListeners: () => { proc?.removeAllListeners(); },
        } as any);

        let stdout = '';
        const maxStdout = 64 * 1024;

        proc.stdout?.on('data', (data: Buffer) => {
          if (stdout.length < maxStdout) {
            stdout += data.toString();
            if (stdout.length > maxStdout) {
              stdout = stdout.slice(0, maxStdout);
            }
          }
        });

        proc.stderr?.on('data', () => { /* drain */ });

        proc.on('error', (err: Error & { code?: string }) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          // Error means process is dead/dying; remove listeners to prevent leaks
          if (proc) {
            proc.removeAllListeners();
          }
          const errCode = err.code;
          const now = clock();
          if (errCode === 'ENOENT') {
            resolve({ status: 'UNKNOWN', reason: 'binary_missing', rtt: null, attemptAt, completionAt: now });
          } else if (errCode === 'EACCES') {
            resolve({ status: 'UNKNOWN', reason: 'permission_denied', rtt: null, attemptAt, completionAt: now });
          } else if (errCode === 'ABORT_ERR' || errCode === 'EPIPE') {
            resolve({ status: 'UNKNOWN', reason: 'aborted', rtt: null, attemptAt, completionAt: now });
          } else {
            resolve({ status: 'UNKNOWN', reason: 'process_error', rtt: null, attemptAt, completionAt: now });
          }
        });

        proc.on('close', (code: number | null) => {
          const alreadyResolved = resolved;
          if (!alreadyResolved) {
            resolved = true;
          }
          // Always do terminal cleanup on close, regardless of prior settlement
          if (proc) {
            proc.removeAllListeners();
          }
          clearTimeout(timer);
          signal?.removeEventListener('abort', abortHandler);

          if (alreadyResolved) {
            // Result already settled (e.g. by abort/timeout); just cleanup
            return;
          }

          const now = clock();
          if (code === 0) {
            const rtt = parseRtt(stdout);
            resolve({ status: 'UP', reason: 'reply_received', rtt, attemptAt, completionAt: now });
          } else if (code === 1) {
            resolve({ status: 'DOWN', reason: 'no_reply', rtt: null, attemptAt, completionAt: now });
          } else if (code === 2) {
            resolve({ status: 'UNKNOWN', reason: 'error_exit', rtt: null, attemptAt, completionAt: now });
          } else if (code === null || code === 143) {
            resolve({ status: 'UNKNOWN', reason: 'timed_out', rtt: null, attemptAt, completionAt: now });
          } else {
            resolve({ status: 'UNKNOWN', reason: `exit_code_${code}`, rtt: null, attemptAt, completionAt: now });
          }
        });
      } catch {
        if (resolved) return;
        resolved = true;
        cleanup();
        const now = clock();
        resolve({ status: 'UNKNOWN', reason: 'spawn_failed', rtt: null, attemptAt, completionAt: now });
      }
    });
  };
}

function realSpawn(cmd: string, args: string[], opts: SpawnOptions): IcmpChildHandle {
  return spawn(cmd, args, opts) as unknown as IcmpChildHandle;
}

export class IcmpAdapter {
  private readonly deps: IcmpAdapterDeps;
  private readonly abortController: AbortController | null;

  constructor(deps: IcmpAdapterDeps) {
    this.deps = deps;
    this.abortController = null;
  }

  async probe(host: string, timeoutMs?: number, signal?: AbortSignal): Promise<IcmpResult> {
    const ms = timeoutMs ?? 3000;
    return this.deps.runPing(host, ms, signal);
  }

  async probeEligible(
    snapshots: Array<{ host: string; generation: number }>,
    concurrency: number,
    timeoutMs: number = 3000,
    signal?: AbortSignal,
  ): Promise<Map<string, IcmpResult>> {
    const results = new Map<string, IcmpResult>();
    const validHosts: string[] = [];

    for (const s of snapshots) {
      const validation = validateHost(s.host);
      if (validation.valid) {
        validHosts.push(s.host);
      } else {
        const now = this.deps.clock();
        results.set(s.host, { status: 'UNKNOWN', reason: validation.reason, rtt: null, attemptAt: now, completionAt: now });
      }
    }

    const batchSize = Math.min(concurrency, validHosts.length);
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) {
        const now = this.deps.clock();
        for (const host of validHosts) {
          results.set(host, { status: 'UNKNOWN', reason: 'probe_error', rtt: null, attemptAt: now, completionAt: now });
        }
        return results;
      }
      const forwardAbort = () => controller.abort();
      signal.addEventListener('abort', forwardAbort, { once: true });
    }

    for (let i = 0; i < validHosts.length; i += batchSize) {
      const batch = validHosts.slice(i, i + batchSize);
      const promises = batch.map(async (host) => {
        try {
          const result = await this.deps.runPing(host, timeoutMs, controller.signal);
          results.set(host, result);
        } catch {
          const now = this.deps.clock();
          results.set(host, { status: 'UNKNOWN', reason: 'probe_error', rtt: null, attemptAt: now, completionAt: now });
        }
      });
      await Promise.allSettled(promises);
    }

    return results;
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
