// Small HTTP layer for job sources: browser-like User-Agent, timeouts, one retry on
// 5xx/network errors, and a distinct error for rate limiting so a source can stop early.

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

/** Thrown on HTTP 429. Sources stop making requests for the rest of the run. */
export class RateLimitedError extends Error {
  constructor(url) {
    super(`Rate limited (429) by ${new URL(url).hostname}`);
    this.name = 'RateLimitedError';
  }
}

/** Thrown on any other non-2xx status after retries. */
export class HttpError extends Error {
  constructor(url, status) {
    super(`HTTP ${status} from ${new URL(url).hostname}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates an HTTP client. fetchImpl and sleepImpl are injectable for tests.
 * get(url, options) resolves to { status, text, url } for 2xx responses.
 */
export function createHttp({ fetchImpl = globalThis.fetch, sleepImpl = sleep, retryDelayMs = 2000 } = {}) {
  async function get(url, { headers = {}, timeoutMs = 20000, retries = 1, method = 'GET', body } = {}) {
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

  async function getJson(url, options = {}) {
    const { text } = await get(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
    return JSON.parse(text);
  }

  async function postJson(url, payload, options = {}) {
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
