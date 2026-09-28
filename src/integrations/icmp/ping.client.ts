export interface PingResult {
  host: string;
  alive: boolean;
  time: number | null;
  error: string | null;
  timestamp: string;
}

export interface PingOptions {
  timeout?: number;
  retries?: number;
}

export class PingClient {
  async ping(host: string, _options: PingOptions = {}): Promise<PingResult> {
    // const { timeout = 5000, retries = 3 } = options; // unused in V1 placeholder

    throw new Error('PingClient.ping not implemented - V1 placeholder (requires NET_RAW capability in Docker)');
  }

  async pingMultiple(hosts: string[], _options: PingOptions = {}): Promise<PingResult[]> {
    throw new Error('PingClient.pingMultiple not implemented - V1 placeholder');
  }
}

export const pingClient = new PingClient();