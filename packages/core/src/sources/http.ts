export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  fetch?: FetchLike;
  /** Retries after the first attempt, for network errors, 429 and 5xx. */
  retries?: number;
  /** Base delay for exponential backoff when the server gives no Retry-After. */
  retryDelayMs?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
  }
}

/** JSON over HTTP with timeouts and retries. A 404 is an answer (`undefined`), not an error. */
export class HttpClient {
  private readonly fetch: FetchLike;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: HttpClientOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.retries = options.retries ?? 4;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.userAgent = options.userAgent ?? 'vitals (dependency health checker)';
  }

  async getJson<T>(url: string): Promise<T | undefined> {
    const response = await this.send(url, { method: 'GET' });
    return response && ((await response.json()) as T);
  }

  /** Size in bytes of the resource at `url`, fetched as a one-byte range so nothing is downloaded. */
  async getSize(url: string): Promise<number | undefined> {
    const response = await this.send(url, { method: 'GET', headers: { range: 'bytes=0-0' } });
    if (!response) return undefined;
    await response.body?.cancel();
    const total = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
    const size = Number(total ?? response.headers.get('content-length'));
    return Number.isFinite(size) && size > 0 ? size : undefined;
  }

  async postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await this.send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response) throw new HttpError(404, url);
    return (await response.json()) as T;
  }

  /** Resolves to a successful response, or `undefined` for 404. */
  private async send(url: string, init: RequestInit): Promise<Response | undefined> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetch(url, {
          ...init,
          headers: { accept: 'application/json', 'user-agent': this.userAgent, ...init.headers },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt >= this.retries) throw error;
        await sleep(this.backoff(attempt));
        continue;
      }

      if (response.ok) return response;
      if (response.status === 404) return undefined;
      if ((response.status === 429 || response.status >= 500) && attempt < this.retries) {
        await sleep(this.backoff(attempt, response.headers.get('retry-after')));
        continue;
      }
      throw new HttpError(response.status, url);
    }
  }

  private backoff(attempt: number, retryAfter?: string | null): number {
    const seconds = Number(retryAfter);
    if (retryAfter && Number.isFinite(seconds)) return Math.min(seconds, 60) * 1000;
    return this.retryDelayMs * 2 ** attempt;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
