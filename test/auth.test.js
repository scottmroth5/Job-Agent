import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { assertSafeBinding, authSettings } from '../server/auth.js';

// Synthetic accounts and a fake Google exchange; no network.
const SITE = 'http://localhost:5178';
const settings = authSettings({
  AUTH_MODE: 'google',
  PUBLIC_URL: SITE,
  GOOGLE_WEB_CLIENT_ID: 'client.apps.example',
  GOOGLE_WEB_CLIENT_SECRET: 'secret',
  AUTH_ALLOWED_EMAILS: 'Pat@Example.com, sam@example.com',
  SESSION_SECRET: randomBytes(48).toString('base64'),
});

async function setup({ claims = {}, exchangeError = null } = {}) {
  const store = openJobStore(':memory:');
  const seen = [];
  const exchange = async (req) => {
    seen.push(req);
    if (exchangeError) throw exchangeError;
    return { email: 'pat@example.com', email_verified: true, nonce: claims.nonce ?? currentNonce, ...claims };
  };
  let currentNonce = null;
  const app = await buildApp({ store, config: { search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null }, authMode: 'google', auth: { settings, exchange } });
  const cookiesFrom = (res) => [res.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  /** Starts a login and returns the login cookie plus Google's state and nonce. */
  const startLogin = async (next = '/') => {
    const res = await app.inject(`/auth/login?next=${encodeURIComponent(next)}`);
    const url = new URL(res.headers.location);
    currentNonce = url.searchParams.get('nonce');
    return { res, url, loginCookie: cookiesFrom(res), state: url.searchParams.get('state') };
  };
  const signIn = async (next = '/') => {
    const { loginCookie, state } = await startLogin(next);
    const res = await app.inject({ url: `/auth/google/callback?state=${state}&code=abc`, headers: { cookie: loginCookie } });
    return { res, session: cookiesFrom(res).split('; ').find((c) => c.startsWith('ja_session=')) };
  };
  return { store, app, seen, startLogin, signIn, setNonce: (n) => (currentNonce = n) };
}

test('signed out: API routes return 401, pages redirect to sign-in, and /healthz stays open', async () => {
  const { app, store } = await setup();
  assert.equal((await app.inject('/api/postings')).statusCode, 401);
  const pageRes = await app.inject('/some/page?x=1');
  assert.equal(pageRes.statusCode, 302);
  assert.equal(pageRes.headers.location, '/auth/login?next=%2Fsome%2Fpage%3Fx%3D1');
  assert.deepEqual((await app.inject('/healthz')).json(), { ok: true });
  await app.close();
  store.close();
});

test('login sends you to Google with state, nonce, PKCE, and only openid email', async () => {
  const { app, store, startLogin } = await setup();
  const { res, url } = await startLogin('/#/funnel');
  assert.equal(res.statusCode, 302);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'openid email');
  assert.equal(url.searchParams.get('redirect_uri'), `${SITE}/auth/google/callback`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  for (const p of ['state', 'nonce', 'code_challenge', 'client_id']) assert.ok(url.searchParams.get(p), p);
  assert.match(res.headers['set-cookie'], /^ja_login=.*HttpOnly; SameSite=Lax; Max-Age=600$/);
  await app.close();
  store.close();
});

test('an allowed, verified account gets a session and reaches the API; sign out ends it', async () => {
  const { app, store, signIn, seen } = await setup();
  const { res, session } = await signIn('/jobs');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/jobs');
  assert.ok(session);
  assert.equal(seen[0].redirectUri, `${SITE}/auth/google/callback`);
  assert.ok(seen[0].codeVerifier.length >= 43, 'the PKCE verifier is sent with the code');
  assert.deepEqual((await app.inject({ url: '/api/me', headers: { cookie: session } })).json(), { authMode: 'google', email: 'pat@example.com' });
  assert.equal((await app.inject({ url: '/api/postings', headers: { cookie: session } })).statusCode, 200);

  // Writes need this site's Origin.
  const write = (origin) => app.inject({ method: 'PATCH', url: '/api/postings/999', headers: { cookie: session, ...(origin ? { origin } : {}) }, payload: { notes: 'x' } });
  assert.equal((await write('https://evil.example')).statusCode, 403);
  assert.equal((await write(null)).statusCode, 403);
  assert.equal((await write(SITE)).statusCode, 404, 'allowed through to the route (no such job)');

  const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: session, origin: SITE } });
  assert.equal(out.statusCode, 204);
  assert.match(out.headers['set-cookie'], /^ja_session=; .*Max-Age=0/);
  await app.close();
  store.close();
});

test('refused: not on the allowlist, unverified email, wrong state or nonce, expired login, Google errors', async () => {
  for (const [claims, status, text] of [
    [{ email: 'eve@example.com' }, 403, /eve@example.com is not allowed/],
    [{ email_verified: false }, 403, /not verified/],
    [{ nonce: 'other' }, 400, /did not match/],
  ]) {
    const { app, store, signIn } = await setup({ claims });
    const { res, session } = await signIn();
    assert.equal(res.statusCode, status, JSON.stringify(claims));
    assert.match(res.body, text);
    assert.equal(session, undefined, 'no session is set');
    await app.close();
    store.close();
  }
  const { app, store, startLogin } = await setup();
  const { loginCookie, state } = await startLogin();
  assert.equal((await app.inject({ url: `/auth/google/callback?state=wrong&code=abc`, headers: { cookie: loginCookie } })).statusCode, 400);
  assert.equal((await app.inject({ url: `/auth/google/callback?state=${state}&code=abc` })).statusCode, 400, 'no login cookie');
  assert.match((await app.inject({ url: '/auth/google/callback?error=access_denied', headers: { cookie: loginCookie } })).body, /access_denied/);
  await app.close();
  store.close();
  const failing = await setup({ exchangeError: new Error('bad code') });
  const s = await failing.signIn();
  assert.equal(s.res.statusCode, 502);
  await failing.app.close();
  failing.store.close();
});

test('removing an address from the allowlist locks that session out at once; a forged cookie is refused', async () => {
  const { app, store, signIn } = await setup();
  const { session } = await signIn();
  settings.allowed.splice(settings.allowed.indexOf('pat@example.com'), 1);
  assert.equal((await app.inject({ url: '/api/postings', headers: { cookie: session } })).statusCode, 401);
  settings.allowed.push('pat@example.com');
  const forged = `ja_session=${Buffer.from(JSON.stringify({ email: 'pat@example.com', exp: Date.now() + 1e9 })).toString('base64url')}.AAAA`;
  assert.equal((await app.inject({ url: '/api/postings', headers: { cookie: forged } })).statusCode, 401);
  await app.close();
  store.close();
});

test('a return path can only be on this site', async () => {
  const { app, store, signIn } = await setup();
  for (const next of ['//evil.example', 'https://evil.example', '/auth/logout']) {
    const { res } = await signIn(next);
    assert.equal(res.headers.location, '/', next);
  }
  await app.close();
  store.close();
});

test('binding rules: none stays on localhost; google needs complete settings and https off localhost', () => {
  assert.doesNotThrow(() => assertSafeBinding({ host: '127.0.0.1' }));
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0' }), /only allows localhost/);
  assert.throws(() => assertSafeBinding({ host: '127.0.0.1', mode: 'magic' }), /not supported/);
  assert.throws(() => assertSafeBinding({ host: '127.0.0.1', mode: 'google', settings: { ...settings, clientId: '' } }), /GOOGLE_WEB_CLIENT_ID/);
  assert.throws(() => assertSafeBinding({ host: '127.0.0.1', mode: 'google', settings: { ...settings, secret: 'short' } }), /32 bytes/);
  assert.doesNotThrow(() => assertSafeBinding({ host: '127.0.0.1', mode: 'google', settings }));
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0', mode: 'google', settings }), /must use https/);
  assert.doesNotThrow(() => assertSafeBinding({ host: '0.0.0.0', mode: 'google', settings: { ...settings, publicUrl: 'https://jobs.example.com' } }));
});

test('open mode: /api/me reports no login', async () => {
  const store = openJobStore(':memory:');
  const app = await buildApp({ store, config: { search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null } });
  assert.deepEqual((await app.inject('/api/me')).json(), { authMode: 'none', email: null });
  assert.equal((await app.inject('/api/postings')).statusCode, 200);
  await app.close();
  store.close();
});
