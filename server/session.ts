// Signed cookies for the sign-in session: base64url(JSON payload) + "." + HMAC-SHA256 signature.
// The payload is readable (it holds only the email and expiry) but cannot be changed without the secret.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'ja_session';
export const LOGIN_COOKIE = 'ja_login';

/** The secret's bytes from SESSION_SECRET (base64 or plain text); at least 32 bytes. */
export function sessionKey(secret: string | null | undefined) {
  const raw = String(secret ?? '');
  const b64 = /^[A-Za-z0-9+/=_-]+$/.test(raw) ? Buffer.from(raw, 'base64') : null;
  const key = b64 && b64.length >= 32 ? b64 : Buffer.from(raw, 'utf8');
  if (key.length < 32) throw new Error('SESSION_SECRET must be at least 32 bytes. Run "npm run auth:setup" to create one.');
  return key;
}

const mac = (key: Buffer, data: string) => createHmac('sha256', key).update(data).digest('base64url');

/** A signed token for payload; exp (ms since epoch) is required. */
export function sign(payload: { exp: number; [field: string]: unknown }, key: Buffer) {
  if (!payload?.exp) throw new Error('sign: payload.exp is required');
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${mac(key, data)}`;
}

/** The payload when the signature is valid and it has not expired, else null. */
export function verify<T extends { exp: number } = { exp: number; [field: string]: unknown }>(token: string | null | undefined, key: Buffer, now = Date.now()): T | null {
  const [data, sig, extra] = String(token ?? '').split('.');
  if (!data || !sig || extra !== undefined) return null;
  const expected = Buffer.from(mac(key, data));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Cookie header -> { name: value }, as an object with no prototype. Names must be plain ([A-Za-z0-9_-], at most 64
 * characters) and never __proto__, constructor, or prototype, so a crafted cookie can never reach an object's
 * prototype; a value that does not decode is dropped rather than failing the request.
 */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const found = new Map<string, string>();
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    found.set(name, value);
  }
  return Object.assign(Object.create(null), Object.fromEntries(found));
}

/** A Set-Cookie value. maxAge in seconds (0 clears the cookie). */
export function cookie(name: string, value: string, { maxAge, secure = false, path = '/', sameSite = 'Lax' }: { maxAge?: number; secure?: boolean; path?: string; sameSite?: string } = {}) {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`, ...(secure ? ['Secure'] : []), ...(maxAge != null ? [`Max-Age=${maxAge}`] : [])].join('; ');
}
