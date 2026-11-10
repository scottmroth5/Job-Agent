// Small HTTP layer for job sources: browser-like User-Agent, timeouts, one retry on
// 5xx/network errors, and a distinct error for rate limiting so a source can stop early.
// It refuses to run inside a database transaction (db/engine/sqlite.ts), which would hold every other statement.
import { assertOutsideTransaction } from '../db/engine/sqlite.ts';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

/** Thrown on HTTP 429. Sources stop making requests for the rest of the run. */
export class RateLimitedError extends Error {
  constructor(url: string) {
    super(`Rate limited (429) by ${new URL(url).hostname}`);
    this.name = 'RateLimitedError';
  }
}

/** Thrown on any other non-2xx status after retries. */
export class HttpError extends Error {
  status: number;
  constructor(url: string, status: number) {
    super(`HTTP ${status} from ${new URL(url).hostname}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates an HTTP client. fetchImpl and sleepImpl are injectable for tests.
 * get(url, options) resolves to { status, text, url } for 2xx responses.
 */
export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  method?: string;
  body?: string;
}

export interface Http {
  get(url: string, options?: RequestOptions): Promise<{ status: number; text: string; url: string }>;
  // any: JSON from another site; each caller checks the fields it reads.
  getJson(url: string, options?: RequestOptions): Promise<any>;
  postJson(url: string, payload: unknown, options?: RequestOptions): Promise<any>;
  sleep: (ms: number) => Promise<unknown>;
}

export function createHttp({ fetchImpl = globalThis.fetch, sleepImpl = sleep, retryDelayMs = 2000 }: { fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<unknown>; retryDelayMs?: number } = {}): Http {
  async function get(url: string, { headers = {}, timeoutMs = 20000, retries = 1, method = 'GET', body }: RequestOptions = {}) {
    assertOutsideTransaction('An HTTP request');
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          body,
          redirect: 'follow',
          headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt < retries) {
          await sleepImpl(retryDelayMs);
          continue;
        }
        throw err;
      }
      if (res.status === 429) throw new RateLimitedError(url);
      if (res.status >= 500 && attempt < retries) {
        await sleepImpl(retryDelayMs);
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new HttpError(url, res.status);
      return { status: res.status, text: await res.text(), url: res.url || url };
    }
  }

  async function getJson(url: string, options: RequestOptions = {}) {
    const { text } = await get(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
    return JSON.parse(text);
  }

  async function postJson(url: string, payload: unknown, options: RequestOptions = {}) {
    const { text } = await get(url, {
      ...options,
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...options.headers },
    });
    return JSON.parse(text);
  }

  return { get, getJson, postJson, sleep: sleepImpl };
}
