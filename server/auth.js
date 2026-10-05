// Access control.
//   AUTH_MODE=none    (default) no login; the server refuses to listen anywhere but localhost.
//   AUTH_MODE=google  "Sign in with Google": only addresses in AUTH_ALLOWED_EMAILS get in. Every page and
//                     API route needs the signed session cookie except /auth/* and /healthz. Works the
//                     same locally and in the cloud; only PUBLIC_URL (and the client's redirect URI) change.
import { createHash, randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { escapeHtml } from '../tools/html.js';
import { SESSION_COOKIE, LOGIN_COOKIE, sessionKey, sign, verify, parseCookies, cookie } from './session.js';

export const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
export const MODES = ['none', 'google'];
export const SESSION_DAYS = 30;
const LOGIN_MINUTES = 10;
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const OPEN_PATHS = [/^\/auth\//, /^\/healthz$/];

/** Sign-in settings from the environment (.env). */
export function authSettings(env = process.env) {
  return {
    mode: env.AUTH_MODE || 'none',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    clientId: env.GOOGLE_WEB_CLIENT_ID || '',
    clientSecret: env.GOOGLE_WEB_CLIENT_SECRET || '',
    allowed: String(env.AUTH_ALLOWED_EMAILS || '')
      .split(/[,\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    secret: env.SESSION_SECRET || '',
  };
}

/** Throws unless the settings are complete and safe for this host. Never includes secret values. */
export function assertSafeBinding({ host, mode = 'none', settings = {} }) {
  if (!MODES.includes(mode)) throw new Error(`AUTH_MODE "${mode}" is not supported. Use none or google.`);
  const loopback = LOOPBACK.includes(host);
  if (mode === 'none') {
    if (!loopback) throw new Error(`AUTH_MODE=none only allows localhost; refusing to listen on ${host}. Set AUTH_MODE=google before exposing the server.`);
    return;
  }
  const missing = [
    ['GOOGLE_WEB_CLIENT_ID', settings.clientId],
    ['GOOGLE_WEB_CLIENT_SECRET', settings.clientSecret],
    ['AUTH_ALLOWED_EMAILS', settings.allowed?.length],
    ['SESSION_SECRET', settings.secret],
    ['PUBLIC_URL', settings.publicUrl],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`AUTH_MODE=google needs ${missing.join(', ')} in .env (npm run auth:setup lists them).`);
  sessionKey(settings.secret);
  let url;
  try {
    url = new URL(settings.publicUrl);
  } catch {
    throw new Error('PUBLIC_URL must be a full URL such as https://jobs.example.com or http://localhost:5178.');
  }
  if (!loopback && url.protocol !== 'https:') throw new Error(`PUBLIC_URL must use https when the server listens on ${host}.`);
}

/** The real Google exchange: code -> verified ID token payload (signature, audience, issuer, expiry). */
export function googleExchange(settings) {
  return async ({ code, codeVerifier, redirectUri }) => {
    const client = new OAuth2Client({ clientId: settings.clientId, clientSecret: settings.clientSecret, redirectUri });
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.id_token) throw new Error('Google did not return an ID token.');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: settings.clientId });
    return ticket.getPayload();
  };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>` +
  `<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1d2330}` +
  `@media (prefers-color-scheme: dark){body{background:#12151b;color:#e6e9ef}a{color:#7fb3d9}}main{max-width:420px;padding:24px}</style></head>` +
  `<body><main><h1 style="font-size:20px">${escapeHtml(title)}</h1>${body}</main></body></html>`;
/** Only same-site paths are allowed as the place to return to after signing in. */
const safeNext = (next) => (typeof next === 'string' && /^\/(?!\/)/.test(next) && !next.startsWith('/auth/') ? next : '/');

/**
 * Registers the auth hook and routes. In google mode, req.user is the signed-in email on every allowed request.
 * @param {{ mode: string, settings?: object, exchange?: Function, now?: () => number }} opts  exchange: googleExchange(settings) (tests pass a fake)
 */
export function registerAuth(app, { mode = 'none', settings = {}, exchange, now = () => Date.now() } = {}) {
  app.get('/api/me', { schema: { summary: 'The signed-in user (google mode) or the open mode', response: { 200: { type: 'object', additionalProperties: true } } } }, async (req) => ({
    authMode: mode,
    email: req.user ?? null,
  }));
  if (mode === 'none') return;
  if (mode !== 'google') throw new Error(`AUTH_MODE "${mode}" is not supported.`);

  const key = sessionKey(settings.secret);
  const origin = new URL(settings.publicUrl).origin;
  const secure = settings.publicUrl.startsWith('https://');
  const redirectUri = `${settings.publicUrl}/auth/google/callback`;
  const signIn = exchange ?? googleExchange(settings);
  const allowed = (email) => settings.allowed.includes(String(email ?? '').toLowerCase());

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (OPEN_PATHS.some((re) => re.test(path))) return;
    const session = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], key, now());
    // The allowlist is checked on every request, so removing an address locks it out at once.
    if (!session || !allowed(session.email)) {
      if (path.startsWith('/api/')) return reply.code(401).send({ error: 'Sign in required.' });
      return reply.redirect(`/auth/login?next=${encodeURIComponent(req.url)}`);
    }
    // Changes must come from this site (on top of SameSite cookies).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== origin) {
      return reply.code(403).send({ error: 'Requests that change data must come from this site.' });
    }
    req.user = session.email;
  });

  app.get('/auth/login', { schema: { hide: true } }, async (req, reply) => {
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const codeVerifier = b64url(randomBytes(32));
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const login = sign({ state, nonce, codeVerifier, next: safeNext(req.query?.next), exp: now() + LOGIN_MINUTES * 60_000 }, key);
    const url = new URL(GOOGLE_AUTH);
    for (const [k, v] of Object.entries({
      client_id: settings.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    })) url.searchParams.set(k, v);
    reply.header('Set-Cookie', cookie(LOGIN_COOKIE, login, { maxAge: LOGIN_MINUTES * 60, secure }));
    return reply.redirect(url.toString());
  });

  app.get('/auth/google/callback', { schema: { hide: true } }, async (req, reply) => {
    const fail = (status, title, body) => reply.code(status).type('text/html').header('Set-Cookie', cookie(LOGIN_COOKIE, '', { maxAge: 0, secure })).send(page(title, body));
    const again = '<p><a href="/auth/login">Try again</a></p>';
    const login = verify(parseCookies(req.headers.cookie)[LOGIN_COOKIE], key, now());
    if (req.query?.error) return fail(400, 'Sign-in cancelled', `<p>Google returned: ${escapeHtml(req.query.error)}.</p>${again}`);
    if (!login || !req.query?.state || req.query.state !== login.state || !req.query?.code) {
      return fail(400, 'Sign-in expired', `<p>The sign-in link was used already or took too long.</p>${again}`);
    }
    let claims;
    try {
      claims = await signIn({ code: req.query.code, codeVerifier: login.codeVerifier, redirectUri });
    } catch (err) {
      req.log?.warn?.({ err: err.name }, 'Google sign-in failed');
      return fail(502, 'Sign-in failed', `<p>Google could not confirm the sign-in.</p>${again}`);
    }
    if (claims?.nonce !== login.nonce) return fail(400, 'Sign-in failed', `<p>The sign-in response did not match this request.</p>${again}`);
    if (!claims.email || claims.email_verified !== true) return fail(403, 'Email not verified', `<p>That Google account's email address is not verified.</p>${again}`);
    if (!allowed(claims.email)) {
      return fail(403, 'Not allowed', `<p>${escapeHtml(claims.email)} is not allowed to use this app.</p><p><a href="/auth/login">Sign in with another account</a></p>`);
    }
    const session = sign({ email: claims.email.toLowerCase(), exp: now() + SESSION_DAYS * 86_400_000, v: 1 }, key);
    reply.header('Set-Cookie', [cookie(SESSION_COOKIE, session, { maxAge: SESSION_DAYS * 86_400, secure }), cookie(LOGIN_COOKIE, '', { maxAge: 0, secure })]);
    return reply.redirect(login.next);
  });

  app.post('/auth/logout', { schema: { hide: true } }, async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== origin) return reply.code(403).send({ error: 'Requests that change data must come from this site.' });
    reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure }));
    return reply.code(204).send();
  });

  app.get('/auth/signed-out', { schema: { hide: true } }, async (req, reply) =>
    reply.type('text/html').send(page('Signed out', '<p><a href="/auth/login">Sign in again</a></p>')),
  );
}
