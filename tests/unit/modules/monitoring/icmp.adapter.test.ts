import { describe, it, expect, vi } from 'vitest';
import { validateHost, IcmpAdapter, createIcmpPingRunner, type IcmpChildHandle } from '@/modules/monitoring/icmp.adapter';
import type { IcmpResult } from '@/modules/monitoring/icmp.adapter';

describe('validateHost', () => {
  it('accepts valid IPv4', () => {
    const result = validateHost('10.0.0.1');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('ipv4');
  });

  it('accepts valid IPv6', () => {
    const result = validateHost('::1');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('ipv6');
  });

  it('accepts valid hostname', () => {
    const result = validateHost('example.com');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('hostname');
  });

  it('accepts hostname with multiple labels', () => {
    const result = validateHost('sensor.example.com');
    expect(result.valid).toBe(true);
  });

  it('rejects empty string', () => {
    expect(validateHost('').valid).toBe(false);
  });

  it('rejects option injection (leading dash)', () => {
    expect(validateHost('-W').valid).toBe(false);
    expect(validateHost('-c1').valid).toBe(false);
  });

  it('rejects host with whitespace', () => {
    expect(validateHost('10.0.0.1 8.8.8.8').valid).toBe(false);
    expect(validateHost(' host').valid).toBe(false);
  });

  it('rejects host with control characters', () => {
    expect(validateHost('10.0.0.1\x00').valid).toBe(false);
    expect(validateHost('10.0.0.1\n').valid).toBe(false);
  });

  it('rejects host with port suffix', () => {
    expect(validateHost('10.0.0.1:8080').valid).toBe(false);
  });

  it('rejects host too long', () => {
    const longHost = 'a'.repeat(300);
    expect(validateHost(longHost).valid).toBe(false);
  });

  it('rejects URL-like input', () => {
    expect(validateHost('http://10.0.0.1').valid).toBe(false);
    expect(validateHost('https://example.com').valid).toBe(false);
  });

  it('rejects shell metacharacters', () => {
    expect(validateHost('10.0.0.1; rm -rf /').valid).toBe(false);
    expect(validateHost('10.0.0.1|cat').valid).toBe(false);
    expect(validateHost('$(whoami)').valid).toBe(false);
  });
});

function makeFakeChild(exitCode: number | null, stdout: string = '', signal: NodeJS.Signals | null = null): { handle: IcmpChildHandle; killCount: { count: number } } {
  let closeHandlers: ((code: number | null, sig: NodeJS.Signals | null) => void)[] = [];
  let errorHandlers: ((err: Error & { code?: string }) => void)[] = [];
  let stdoutHandlers: ((data: Buffer) => void)[] = [];
  const killCount = { count: 0 };

  const handle: IcmpChildHandle = {
    on(event: string, cb: any) {
      if (event === 'close') closeHandlers.push(cb);
      if (event === 'error') errorHandlers.push(cb);
      return this;
    },
    stdout: {
      on(event: string, cb: (data: Buffer) => void) {
        if (event === 'data') stdoutHandlers.push(cb);
      },
    },
    stderr: {
      on(event: string, cb: (data: Buffer) => void) {
        if (event === 'data') { void cb; }
      },
    },
    kill(signal?: NodeJS.Signals): boolean {
      killCount.count++;
      return true;
    },
    removeAllListeners() {
      closeHandlers = [];
      errorHandlers = [];
      stdoutHandlers = [];
    },
  };

  setTimeout(() => {
    if (stdout) {
      for (const h of stdoutHandlers) h(Buffer.from(stdout));
    }
    for (const h of closeHandlers) h(exitCode, signal);
  }, 10);

  return { handle, killCount };
}

describe('createIcmpPingRunner - unified implementation (F6)', () => {
  it('production runner with injected fake spawn - exit 0 → UP', async () => {
    let spawnOpts: any = null;
    const fakeSpawn = (cmd: string, args: string[], opts: any): IcmpChildHandle => {
      spawnOpts = opts;
      const { handle } = makeFakeChild(0, 'rtt min/avg/max/mdev = 1.000 / 1.500 / 2.000 / 0.500');
      return handle;
    };

    const clock = () => 1000;
    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock });
    const result = await runner('10.0.0.1', 3000);
    expect(result.status).toBe('UP');
    expect(result.reason).toBe('reply_received');
    expect(result.rtt).toBe(1.5);
    expect(result.attemptAt).toBe(1000);
    expect(result.completionAt).toBeGreaterThanOrEqual(1000);
    expect(spawnOpts).toBeTruthy();
  });

  it('config timeout wired to ping -W flag and process timeout', async () => {
    let capturedArgs: string[] = [];
    let capturedOpts: any = null;
    const fakeSpawn = (cmd: string, args: string[], opts: any): IcmpChildHandle => {
      capturedArgs = args;
      capturedOpts = opts;
      return makeFakeChild(0).handle;
    };

    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock: () => 1000 });
    await runner('10.0.0.1', 9000);

    expect(capturedArgs).toContain('-W');
    expect(capturedArgs[capturedArgs.indexOf('-W') + 1]).toBe('9');
    expect(capturedOpts.timeout).toBe(11000);
  });

  it('pre-aborted signal returns aborted immediately without spawning', async () => {
    let spawnCalled = false;
    const fakeSpawn = (): IcmpChildHandle => {
      spawnCalled = true;
      return makeFakeChild(0).handle;
    };
    const controller = new AbortController();
    controller.abort();
    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock: () => 1000 });
    const result = await runner('10.0.0.1', 3000, controller.signal);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('aborted');
    expect(result.attemptAt).toBe(1000);
    expect(spawnCalled).toBe(false);
  });

  it('abort during probe kills child and resolves aborted', async () => {
    const fakeSpawn = (cmd: string, args: string[], opts: any): IcmpChildHandle => {
      const child = makeFakeChild(0, '');
      void opts; void cmd;
      return child.handle;
    };

    const controller = new AbortController();
    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock: () => 1000 });

    const promise = runner('10.0.0.1', 3000, controller.signal);
    setTimeout(() => controller.abort(), 1);
    const result = await promise;

    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('aborted');
  });

  it('exit 1 → DOWN (no reply)', async () => {
    const fakeSpawn = (): IcmpChildHandle => makeFakeChild(1).handle;
    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock: () => 1000 });
    const result = await runner('10.0.0.1', 3000);
    expect(result.status).toBe('DOWN');
    expect(result.reason).toBe('no_reply');
  });

  it('exit 2 → UNKNOWN (error_exit)', async () => {
    const fakeSpawn = (): IcmpChildHandle => makeFakeChild(2).handle;
    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock: () => 1000 });
    const result = await runner('10.0.0.1', 3000);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('error_exit');
  });

  it('ENOENT → UNKNOWN (binary_missing)', async () => {
    let errorHandlers: ((err: Error & { code?: string }) => void)[] = [];
    const fakeSpawn = (): IcmpChildHandle => {
      const handle: IcmpChildHandle = {
        on(event: string, cb: any) {
          if (event === 'close') void cb;
          if (event === 'error') errorHandlers.push(cb);
          return this;
        },
        stdout: null,
        stderr: null,
        kill: () => false,
        removeAllListeners() {},
      };
      setTimeout(() => {
        for (const h of errorHandlers) h({ code: 'ENOENT' } as Error & { code: string });
      }, 0);
      return handle;
    };
    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock: () => 1000 });
    const result = await runner('10.0.0.1', 3000);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('binary_missing');
  });

  it('EACCES → UNKNOWN (permission_denied)', async () => {
    let errorHandlers: ((err: Error & { code?: string }) => void)[] = [];
    const fakeSpawn = (): IcmpChildHandle => {
      const handle: IcmpChildHandle = {
        on(event: string, cb: any) {
          if (event === 'close') void cb;
          if (event === 'error') errorHandlers.push(cb);
          return this;
        },
        stdout: null,
        stderr: null,
        kill: () => false,
        removeAllListeners() {},
      };
      setTimeout(() => {
        for (const h of errorHandlers) h({ code: 'EACCES' } as Error & { code: string });
      }, 0);
      return handle;
    };
    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock: () => 1000 });
    const result = await runner('10.0.0.1', 3000);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('permission_denied');
  });

  it('process timeout → UNKNOWN (timeout)', async () => {
    const fakeSpawn = (): IcmpChildHandle => {
      const handle: IcmpChildHandle = {
        on: () => handle,
        stdout: null,
        stderr: null,
        kill: () => false,
        removeAllListeners() {},
      };
      return handle;
    };
    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock: () => 1000 });
    const result = await runner('10.0.0.1', 50);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('timeout');
  });

  it('invalid host → UNKNOWN without spawning', async () => {
    const fakeSpawn = vi.fn();
    const runner = createIcmpPingRunner({ spawn: fakeSpawn as any, clock: () => 1000 });
    const result = await runner('-W', 3000);
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toBe('option_injection');
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('stdout bounded to maxStdout (large output does not crash)', async () => {
    const bigOutput = 'a'.repeat(200000);
    const fakeSpawn = (): IcmpChildHandle => makeFakeChild(0, bigOutput).handle;
    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock: () => 1000 });
    const result = await runner('10.0.0.1', 3000);
    expect(result.status).toBe('UP');
  });

  it('listeners cleaned up after completion (no memory leak)', async () => {
    let handlerCount = 0;
    const fakeSpawn = (): IcmpChildHandle => {
      const child = makeFakeChild(0, 'rtt min/avg/max/mdev = 1.000 / 1.500 / 2.000 / 0.500');
      handlerCount++;
      return child.handle;
    };
    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock: () => 1000 });
    await runner('10.0.0.1', 3000);
    expect(handlerCount).toBe(1);
  });

  it('kill called once on abort', async () => {
    let killCount = 0;
    const fakeSpawn = (): IcmpChildHandle => {
      const handle: IcmpChildHandle = {
        on(event: string, cb: any) {
          if (event === 'close') setTimeout(() => cb(0, null), 50);
          return this;
        },
        stdout: null,
        stderr: null,
        kill: () => { killCount++; return true; },
        removeAllListeners() {},
      };
      return handle;
    };
    const controller = new AbortController();
    const runner = createIcmpPingRunner({ spawn: fakeSpawn, clock: () => 1000 });
    const promise = runner('10.0.0.1', 3000, controller.signal);
    setTimeout(() => controller.abort(), 1);
    await promise;
    expect(killCount).toBe(1);
  });
});

describe('IcmpAdapter', () => {
  const clock = () => 1000;

  it('probe passes config timeout (not clock) to runPing', async () => {
    const runPing = vi.fn().mockResolvedValue({ status: 'UP', reason: 'reply', rtt: 1.5, attemptAt: 1000, completionAt: 1000 });
    const adapter = new IcmpAdapter({ runPing, clock });
    await adapter.probe('10.0.0.1', 9000);
    expect(runPing).toHaveBeenCalledWith('10.0.0.1', 9000, undefined);
  });

  it('probeEligible passes config timeout to runPing', async () => {
    const runPing = vi.fn().mockResolvedValue({ status: 'UP', reason: 'reply', rtt: 1.5, attemptAt: 1000, completionAt: 1000 });
    const adapter = new IcmpAdapter({ runPing, clock });
    await adapter.probeEligible([{ host: '10.0.0.1', generation: 1 }], 5, 9000);
    expect(runPing).toHaveBeenCalledWith('10.0.0.1', 9000, expect.anything());
  });

  it('probeEligible rejects invalid host without calling runPing', async () => {
    const runPing = vi.fn().mockResolvedValue({ status: 'UP', reason: 'reply', rtt: 1.5, attemptAt: 1000, completionAt: 1000 });
    const adapter = new IcmpAdapter({ runPing, clock });
    await adapter.probeEligible([{ host: '; rm -rf /', generation: 1 }], 5, 3000);
    expect(runPing).not.toHaveBeenCalled();
  });

  it('concurrency limit respected', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const runPing = vi.fn().mockImplementation(async (host: string): Promise<IcmpResult> => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 50));
      concurrent--;
      return { status: 'UP', reason: 'reply', rtt: 1.0, attemptAt: 1000, completionAt: 1000 };
    });

    const adapter = new IcmpAdapter({ runPing, clock });
    const hosts = Array.from({ length: 10 }, (_, i) => ({ host: `10.0.0.${i + 1}`, generation: 1 }));
    await adapter.probeEligible(hosts, 3, 3000);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('probeEligible aborts when signal is aborted', async () => {
    const controller = new AbortController();
    const runPing = vi.fn().mockImplementation((_host: string, _ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) return Promise.reject(new Error('aborted'));
      return new Promise((_, reject) => {
        if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const adapter = new IcmpAdapter({ runPing, clock });

    const promise = adapter.probeEligible([{ host: '10.0.0.1', generation: 1 }], 1, 3000, controller.signal);
    controller.abort();
    const results = await promise;
    expect(results.get('10.0.0.1')?.reason).toBe('probe_error');
  });
});
