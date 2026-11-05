// Protections for running on the internet: security headers on every response, rate limits on sign-in and on
// repeated refused requests, and server errors that never reveal internals. In AUTH_MODE=none the server only
// listens on this computer, so the rate limits are off there; the headers are always on.
import type { App, FastifyReply } from './types.ts';

type Limit = { windowMs: number; max: number };

// The web page loads only its own scripts and styles. 'unsafe-inline' for styles covers React style attributes;
// scripts stay strict, so injected markup can never run code. connect adds origins the page may send to (the demo's
// analytics host, server/demo-analytics.ts); no script is ever loaded from them.
export const contentSecurityPolicy = ({ connect = [] }: { connect?: string[] } = {}) => [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  ["connect-src 'self'", ...connect].join(' '),
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
export const CONTENT_SECURITY_POLICY = contentSecurityPolicy();

/**
 * Adds security headers to every response; a route that set its own (attachments' sandbox policy) keeps it.
 * https adds Strict-Transport-Security; connect, see above.
 */
export function registerSecurityHeaders(app: App, { https = false, connect = [] }: { https?: boolean; connect?: string[] } = {}) {
  const headers: Record<string, string> = {
    'content-security-policy': contentSecurityPolicy({ connect }),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    // The page loads only its own files, so it can refuse anything cross-origin that does not opt in.
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    ...(https ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
  app.addHook('onSend', async (req, reply, payload) => {
    for (const [name, value] of Object.entries(headers)) if (!reply.hasHeader(name)) reply.header(name, value);
    return payload;
  });
}

/** A fixed-window counter per key (client address). In memory: a restart clears it, which is fine for one server. */
export function createRateLimiter({ windowMs, max, now = () => Date.now() }: Limit & { now?: () => number }) {
  const hits = new Map<string, { start: number; count: number }>();
  const prune = (t: number) => {
    for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
  };
  return {
    /** Counts one hit. Returns { allowed, retryAfterSeconds }. */
    hit(key: string) {
      const t = now();
      if (hits.size > 10000) prune(t);
      let entry = hits.get(key);
      if (!entry || t - entry.start >= windowMs) entry = { start: t, count: 0 };
      entry.count += 1;
      hits.set(key, entry);
      return { allowed: entry.count <= max, retryAfterSeconds: Math.ceil((entry.start + windowMs - t) / 1000) };
    },
    /** Whether the key is over the limit, without counting. */
    blocked(key: string) {
      const entry = hits.get(key);
      return Boolean(entry && now() - entry.start < windowMs && entry.count > max);
    },
    retryAfter(key: string) {
      const entry = hits.get(key);
      return entry ? Math.max(1, Math.ceil((entry.start + windowMs - now()) / 1000)) : 1;
    },
  };
}

export const SIGN_IN_LIMIT = { windowMs: 15 * 60 * 1000, max: 30 };
export const REFUSED_LIMIT = { windowMs: 15 * 60 * 1000, max: 100 };
// The public demo has no sign-in, so every request counts: plenty for a person clicking around (a screen makes a
// handful of requests), far too few for a script hammering the server.
export const DEMO_REQUEST_LIMIT = { windowMs: 15 * 60 * 1000, max: 1500 };

/**
 * Rate limits for an internet-facing server: at most 30 sign-in requests (/auth/*) per address per 15 minutes,
 * and an address with more than 100 refused requests (401 or 403) in 15 minutes is turned away until the window
 * ends. all (the public demo) also caps every request per address. Register before the sign-in check so a blocked
 * address is refused first.
 */
export function registerRateLimits(
  app: App,
  { signIn = SIGN_IN_LIMIT, refused = REFUSED_LIMIT, all = null, now }: { signIn?: Limit; refused?: Limit; all?: Limit | null; now?: () => number } = {},
) {
  const signInLimiter = createRateLimiter({ ...signIn, now });
  const refusedLimiter = createRateLimiter({ ...refused, now });
  const allLimiter = all ? createRateLimiter({ ...all, now }) : null;
  const tooMany = (reply: FastifyReply, seconds: number) =>
    reply.code(429).header('retry-after', String(seconds)).send({ error: 'Too many requests from this address. Try again later.' });

  app.addHook('onRequest', async (req, reply) => {
    if (refusedLimiter.blocked(req.ip)) return tooMany(reply, refusedLimiter.retryAfter(req.ip));
    if (allLimiter && req.url !== '/healthz') {
      const r = allLimiter.hit(req.ip);
      if (!r.allowed) return tooMany(reply, r.retryAfterSeconds);
    }
    if (req.url.startsWith('/auth/')) {
      const r = signInLimiter.hit(req.ip);
      if (!r.allowed) return tooMany(reply, r.retryAfterSeconds);
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode === 401 || reply.statusCode === 403) refusedLimiter.hit(req.ip);
  });
}

/**
 * The reply body for an error: what went wrong for the caller's mistakes (4xx), and a plain message for server
 * faults (5xx), whose details go to the server log only (never request bodies).
 */
export function errorReply(
  err: { statusCode?: number; validation?: unknown; name: string; message: string },
  req: { method: string; url: string },
  log: { error?: (text: string) => void } = console,
) {
  const status = err.statusCode ?? (err.validation ? 400 : 500);
  if (status < 500) return { status, body: { error: err.message } };
  log.error?.(`[error] ${req.method} ${req.url.split('?')[0]}: ${err.name}: ${err.message}`);
  return { status, body: { error: 'Something went wrong on the server. The details are in the server log.' } };
}
