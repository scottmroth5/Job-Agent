// Access control.
//   AUTH_MODE=none    (default) no login; the server refuses to listen anywhere but localhost.
//   AUTH_MODE=google  "Sign in with Google". Any verified Google account can sign in; what it may do depends on its
//                     account (db/users.js): the addresses in AUTH_ALLOWED_EMAILS are the owner's; anyone else
//                     requests access (/auth/register) and waits for the owner's approval (/auth/waiting), or is
//                     told it was not approved (/auth/not-approved). Every page and API route needs the signed session
//                     cookie and an active (or paused, read-only) account, except /auth/*, /healthz, /privacy,
//                     /terms, and the Add to Home Screen files. Works the same locally and in the cloud; only
//                     PUBLIC_URL (and the client's redirect URI) change.
//   AUTH_MODE=demo    A public, read-only showcase over a sample database (npm run demo:seed): no login, every
//                     request that would change data is refused, and the server starts without Claude, Gmail,
//                     or Drive (server/index.js), so nothing a visitor does can spend money or reach an account.
import { createHash, randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { escapeHtml } from '../tools/html.js';
import { supportEmail } from '../tools/support.js';
import { accountFor, getUser, MAX_NAME, MAX_NOTE, requestAccess } from '../db/users.js';
import { SESSION_COOKIE, LOGIN_COOKIE, sessionKey, sign, verify, parseCookies, cookie } from './session.js';
import { DEMO_CONFIG, DEMO_EMAIL } from '../demo/sample-data.js';

export const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
export const MODES = ['none', 'google', 'demo'];
export const SESSION_DAYS = 30;
const LOGIN_MINUTES = 10;
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
// The app icons and manifest are open too: iOS fetches them for Add to Home Screen without the session cookie
// (static files from web/public, nothing personal).
const OPEN_PATHS = [/^\/auth\//, /^\/healthz$/, /^\/(manifest\.webmanifest|icon-(180|192|512)\.png|favicon\.ico|favicon-(16x16|32x32)\.png)$/, /^\/(privacy|terms)$/];
// Open requests for access at most; past this the request page says requests are closed for now.
export const MAX_PENDING = 50;
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];
// The only non-read request a demo visitor may make: filling a prompt draft with a sample job. It writes nothing
// and calls no model (server/admin.js), so Settings > Prompts' preview works in the demo.
const DEMO_WRITES = [/^\/api\/prompts\/[a-z-]+\/preview$/];
export const DEMO_REFUSAL = 'This is a read-only demo with sample data, so changes are turned off.';

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
    // The demo's "Request access" link: the real app's address.
    requestAccessUrl: env.REQUEST_ACCESS_URL || '',
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
  if (mode === 'demo') {
    if (loopback) return;
    if (!settings.publicUrl) throw new Error('AUTH_MODE=demo needs PUBLIC_URL in .env when the server is reachable from other computers.');
    let demoUrl;
    try {
      demoUrl = new URL(settings.publicUrl);
    } catch {
      throw new Error('PUBLIC_URL must be a full URL such as https://demo.example.com.');
    }
    if (demoUrl.protocol !== 'https:') throw new Error(`PUBLIC_URL must use https when the server listens on ${host}.`);
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
export const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>` +
  `<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1d2330}` +
  `*{box-sizing:border-box}input,textarea,button{font:inherit}input,textarea{border:1px solid #c9ced8;border-radius:8px}` +
  `button{padding:8px 16px;border-radius:8px;border:1px solid #c9ced8;background:#fff;color:inherit;cursor:pointer}button.primary{background:#1a5276;border-color:#1a5276;color:#fff}form{margin:12px 0}` +
  `@media (prefers-color-scheme: dark){body{background:#12151b;color:#e6e9ef}a{color:#7fb3d9}input,textarea,button{background:#1b2029;color:#e6e9ef;border-color:#2c3340}}main{max-width:420px;width:100%;padding:24px 16px}</style></head>` +
  `<body><main><h1 style="font-size:20px">${escapeHtml(title)}</h1>${body}${supportLine()}</main></body></html>`;
// The sign-in pages say where to ask for help, when SUPPORT_EMAIL is set.
const supportLine = () => {
  const email = supportEmail();
  return email ? `<p style="font-size:14px;opacity:.75">Questions? Email <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>.</p>` : '';
};
/**
 * Only same-site paths are allowed as the place to return to after signing in. Browsers read a backslash as a slash,
 * so "/\evil.example" would mean "//evil.example" (another site): backslashes, control characters, and anything that
 * is not a single leading slash are refused, as are the sign-in pages themselves.
 */
export const safeNext = (next) =>
  typeof next === 'string' && next.length <= 2000 && /^\/(?![/\\])/.test(next) && !/[\\\u0000-\u001f\u007f]/.test(next) && !next.startsWith('/auth/')
    ? next
    : '/';

/**
 * Registers the auth hook and routes. In google mode, req.user is the signed-in email and req.account its account
 * ({ uid, status, role }) on every request that gets through.
 * @param {object} opts
 * @param {string} opts.mode
 * @param {object} [opts.settings]
 * @param {Function} [opts.exchange]  googleExchange(settings) (tests pass a fake)
 * @param {() => number} [opts.now]
 * @param {import('better-sqlite3').Database} [opts.db]  the job database (accounts)
 * @param {{ accessRequested?: Function }} [opts.notices]  server/notices.js
 */
export function registerAuth(app, { mode = 'none', settings = {}, exchange, now = () => Date.now(), db = null, notices = {} } = {}) {
  app.get('/api/me', { schema: { summary: 'The signed-in user and their account (google mode), or the open mode', response: { 200: { type: 'object', additionalProperties: true } } } }, async (req) => {
    const user = req.account ? getUser(db, req.account.uid) : null;
    return {
      authMode: mode,
      email: req.user ?? (mode === 'demo' ? DEMO_EMAIL : null),
      supportEmail: supportEmail(),
      ...(req.account ? { role: req.account.role, status: req.account.status, owner: req.account.uid === 1, name: user?.name ?? null } : { owner: mode === 'none', role: mode === 'none' ? 'admin' : null }),
      ...(mode === 'demo' ? { demo: true, name: DEMO_CONFIG.candidate.name, requestAccessUrl: settings.requestAccessUrl || null } : {}),
    };
  });
  if (mode === 'none') return;
  if (mode === 'demo') {
    app.addHook('onRequest', async (req, reply) => {
      if (READ_METHODS.includes(req.method)) return;
      const path = req.url.split('?')[0];
      if (req.method === 'POST' && DEMO_WRITES.some((re) => re.test(path))) return;
      return reply.code(403).send({ error: DEMO_REFUSAL });
    });
    return;
  }
  if (mode !== 'google') throw new Error(`AUTH_MODE "${mode}" is not supported.`);

  const key = sessionKey(settings.secret);
  const origin = new URL(settings.publicUrl).origin;
  const secure = settings.publicUrl.startsWith('https://');
  const redirectUri = `${settings.publicUrl}/auth/google/callback`;
  const signIn = exchange ?? googleExchange(settings);
  const sessionOf = (req) => verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], key, now());
  const sameSite = (req) => req.headers.origin === origin;
  // Where an address without a usable account goes, and what an API call is told.
  const WAITING = { none: '/auth/register', pending: '/auth/waiting', rejected: '/auth/not-approved' };
  const REFUSED = { none: 'Request access to use this app.', pending: 'Your request for access is waiting for approval.', rejected: 'Your request for access was not approved.' };

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (OPEN_PATHS.some((re) => re.test(path))) return;
    const session = sessionOf(req);
    if (!session) {
      if (path.startsWith('/api/')) return reply.code(401).send({ error: 'Sign in required.' });
      return reply.redirect(`/auth/login?next=${encodeURIComponent(req.url)}`);
    }
    // The account is read on every request, so approving, pausing, or removing an address takes effect at once.
    const account = accountFor(db, session.email, settings.allowed);
    const state = account?.status ?? 'none';
    if (WAITING[state]) {
      if (path.startsWith('/api/')) return reply.code(403).send({ error: REFUSED[state], account: state });
      return reply.redirect(WAITING[state]);
    }
    // Changes must come from this site (on top of SameSite cookies).
    if (!READ_METHODS.includes(req.method) && !sameSite(req)) {
      return reply.code(403).send({ error: 'Requests that change data must come from this site.' });
    }
    req.user = session.email;
    req.account = account;
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
    // Any verified address gets a session; the account decides what it may do (the onRequest hook above).
    const session = sign({ email: claims.email.toLowerCase(), exp: now() + SESSION_DAYS * 86_400_000, v: 1 }, key);
    reply.header('Set-Cookie', [cookie(SESSION_COOKIE, session, { maxAge: SESSION_DAYS * 86_400, secure }), cookie(LOGIN_COOKIE, '', { maxAge: 0, secure })]);
    return reply.redirect(login.next);
  });

  app.post('/auth/logout', { schema: { hide: true } }, async (req, reply) => {
    if (req.headers.origin && !sameSite(req)) return reply.code(403).send({ error: 'Requests that change data must come from this site.' });
    reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure }));
    return reply.code(204).send();
  });

  app.get('/auth/signed-out', { schema: { hide: true } }, async (req, reply) =>
    reply.type('text/html').send(page('Signed out', '<p><a href="/auth/login">Sign in again</a></p>')),
  );

  // Requesting access: a form (no script; the page's CSP allows none inline), posted as a URL-encoded body.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8192 }, (req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });
  const signOut = '<form method="post" action="/auth/logout-form"><button type="submit">Sign out</button></form>';
  const html = (reply, title, body, status = 200) => reply.code(status).type('text/html').header('Cache-Control', 'no-store').send(page(title, body));
  // Each page is for one account state: { session } when the visitor is in it, else { go } (where they belong instead:
  // sign in, another of these pages, or the app). Callers redirect on go and never read the session then.
  const statePage = (req, want) => {
    const session = sessionOf(req);
    if (!session?.email) return { go: '/auth/login' };
    const state = accountFor(db, session.email, settings.allowed)?.status ?? 'none';
    if (state !== want) return { go: WAITING[state] ?? '/' };
    return { session };
  };

  app.get('/auth/register', { schema: { hide: true } }, async (req, reply) => {
    const { session, go } = statePage(req, 'none');
    if (go) return reply.redirect(go);
    const closed = db.prepare("SELECT COUNT(*) FROM users WHERE status = 'pending'").pluck().get() >= MAX_PENDING;
    if (closed) return html(reply, 'Requests are closed', '<p>Job Hunt is not taking new requests for access right now. Please try again later.</p>' + signOut);
    return html(
      reply,
      'Request access',
      `<p>You are signed in as <strong>${escapeHtml(session.email)}</strong>. Job Hunt is invite-only: tell the owner who you are, and you will get an email when your account is ready.</p>
      <form method="post" action="/auth/register" style="display:grid;gap:10px">
        <label>Your name<br><input name="name" required maxlength="${MAX_NAME}" autocomplete="name" style="width:100%;padding:6px"></label>
        <label>A note for the owner (optional)<br><textarea name="note" maxlength="${MAX_NOTE}" rows="4" style="width:100%;padding:6px"></textarea></label>
        <label><input type="checkbox" name="terms" value="yes" required> I accept the <a href="/terms" target="_blank">terms</a> and the <a href="/privacy" target="_blank">privacy policy</a>.</label>
        <button type="submit" class="primary">Request access</button>
      </form>${signOut}`,
    );
  });

  app.post('/auth/register', { schema: { hide: true } }, async (req, reply) => {
    if (!sameSite(req)) return reply.code(403).send({ error: 'Requests that change data must come from this site.' });
    const { session, go } = statePage(req, 'none');
    if (go) return reply.code(303).redirect(go);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.terms !== 'yes') return html(reply, 'Request access', '<p>Please accept the terms and privacy policy.</p><p><a href="/auth/register">Back</a></p>', 400);
    if (db.prepare("SELECT COUNT(*) FROM users WHERE status = 'pending'").pluck().get() >= MAX_PENDING) return reply.redirect('/auth/register');
    let result;
    try {
      result = requestAccess(db, { email: session.email, name: body.name, note: body.note });
    } catch (err) {
      if (err.statusCode === 400) return html(reply, 'Request access', `<p>${escapeHtml(err.message)}</p><p><a href="/auth/register">Back</a></p>`, 400);
      throw err;
    }
    if (result.created) await notices.accessRequested?.(getUser(db, result.id));
    return reply.code(303).redirect('/auth/waiting');
  });

  app.get('/auth/waiting', { schema: { hide: true } }, async (req, reply) => {
    const { go } = statePage(req, 'pending');
    if (go) return reply.redirect(go);
    return html(reply, 'Waiting for approval', '<p>Thanks. Your request is with the owner, and you will get an email when your account is ready.</p>' + signOut);
  });

  app.get('/auth/not-approved', { schema: { hide: true } }, async (req, reply) => {
    const { go } = statePage(req, 'rejected');
    if (go) return reply.redirect(go);
    return html(reply, 'Not approved', '<p>Your request for access to Job Hunt was not approved.</p>' + signOut);
  });

  // The pages above sign out with a plain form (no script), so this one answers a form post with a page.
  app.post('/auth/logout-form', { schema: { hide: true } }, async (req, reply) => {
    if (!sameSite(req)) return reply.code(403).send({ error: 'Requests that change data must come from this site.' });
    reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure }));
    return reply.code(303).redirect('/auth/signed-out');
  });
}
