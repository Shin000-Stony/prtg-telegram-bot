export type ResponseSpec = { statusCode: number; body?: string; headers?: Record<string, string> };

export class FakeResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  private dataListeners: Array<(chunk: string) => void> = [];
  private endListeners: Array<() => void> = [];
  private errorListeners: Array<(err: Error) => void> = [];
  private timeoutListeners: Array<() => void> = [];
  resumed = false;
  destroyed = false;
  readonly req: {
    on: (event: string, cb: (e: Error) => void) => void;
    end: () => void;
    destroy: (err?: Error) => void;
    setTimeout?: (ms: number, cb: () => void) => void;
  };

  constructor(spec: ResponseSpec) {
    this.statusCode = spec.statusCode;
    this.headers = spec.headers ?? {};
    this.req = {
      on: (event: string, cb: (e: Error) => void) => {
        if (event === 'error') {
          this.errorListeners.push(cb);
        }
      },
      end: () => {},
      destroy: (err?: Error) => {
        this.destroyed = true;
        if (err) {
          this.errorListeners.forEach((l) => l(err));
        }
      },
      setTimeout: () => {},
    };
  }

  setEncoding(): void {}
  on(event: string, cb: (...args: unknown[]) => void): void {
    if (event === 'data') {
      this.dataListeners.push(cb as (chunk: string) => void);
    } else if (event === 'end') {
      this.endListeners.push(cb as () => void);
    } else if (event === 'error') {
      this.errorListeners.push(cb as (err: Error) => void);
    } else if (event === 'timeout') {
      this.timeoutListeners.push(cb as () => void);
    }
  }
  resume(): void {
    this.resumed = true;
  }

  emitData(chunk: string): void {
    this.dataListeners.forEach((l) => l(chunk));
  }

  emitEnd(): void {
    this.endListeners.forEach((l) => l());
  }

  flush(body: string): void {
    for (let i = 0; i < body.length; i += 65536) {
      this.emitData(body.slice(i, i + 65536));
    }
    this.emitEnd();
  }

  flushObject(obj: unknown): void {
    this.flush(JSON.stringify(obj));
  }
}

export class FakeHttps {
  readonly requests: Array<{ options: any; res: FakeResponse }> = [];
  private readonly specs: ResponseSpec[];

  constructor(specs: ResponseSpec[] = []) {
    this.specs = specs;
  }

  request(options: any, cb: (res: FakeResponse) => void): FakeResponse['req'] {
    const spec = this.specs[this.requests.length] ?? { statusCode: 200, body: '[]' };
    const res = new FakeResponse(spec);
    this.requests.push({ options, res });
    cb(res);
    return res.req;
  }

  static asModule(specs: ResponseSpec[]): any {
    return new FakeHttps(specs);
  }
}
