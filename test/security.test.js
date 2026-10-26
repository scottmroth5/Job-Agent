// Internet hardening: every route needs sign-in, security headers, rate limits, and safe server errors.
// Synthetic accounts, a fake Google exchange, and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { CONTENT_SECURITY_POLICY, createRateLimiter, errorReply } from '../server/security.js';

const settingsFor = (publicUrl) =>
  authSettings({
    AUTH_MODE: 'google',
    PUBLIC_URL: publicUrl,
    GOOGLE_WEB_CLIENT_ID: 'client.apps.example',
    GOOGLE_WEB_CLIENT_SECRET: 'secret',
    AUTH_ALLOWED_EMAILS: 'pat@example.com',
    SESSION_SECRET: randomBytes(48).toString('base64'),
  });

/** An app with every optional route group turned on, and a built page to serve. */
async function fullApp({ authMode = 'google', publicUrl = 'https://jobs.example.com', log } = {}) {
  const store = openJobStore(':memory:');
  const webDir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Job Hunt</title>');
  const app = await buildApp({
    store,
    config: { candidate: { name: 'P' }, search: { homeLocations: [] }, fractional: {}, coverLetterChecks: [] },
    webDir,
    authMode,
    auth: authMode === 'google' ? { settings: settingsFor(publicUrl), exchange: async () => ({}) } : {},
    services: {
      createBrowser: async () => null,
      runPipeline: async () => ({ code: 0, lastError: null }),
      runScript: async () => ({ code: 0, lastError: null }),
      inbox: { ready: () => false, gmail: () => ({}), key: () => Buffer.alloc(32), cfg: {} },
      log: log ?? { info() {}, warn() {}, error() {} },
    },
  });
  return { app, store };
}

// Public on purpose: sign-in itself, the health check, and the privacy policy and terms (linked before sign-in).
const OPEN = [/^\/auth\//, /^\/healthz$/, /^\/(privacy|terms)$/];
const sampleUrl = (url) => url.replace(/:(\w+)/g, (_, name) => (name === 'id' ? '1' : name === 'action' ? 'score' : name === 'list' ? 'status' : name === 'name' ? 'score' : 'x')).replaceAll('*', 'index.html');

test('every route except sign-in and /healthz needs sign-in: API routes answer 401, pages redirect to sign-in', async () => {
  const { app, store } = await fullApp();
  await app.ready();
  const checked = [];
  for (const r of app.routeList) {
    if (OPEN.some((re) => re.test(r.url))) continue;
    for (const method of [r.method].flat()) {
      if (method === 'OPTIONS') continue;
      const url = sampleUrl(r.url);
      const res = await app.inject({ method, url, payload: ['POST', 'PUT', 'PATCH'].includes(method) ? {} : undefined, remoteAddress: `10.0.${checked.length >> 8}.${checked.length & 255}` });
      if (url.startsWith('/api/')) assert.equal(res.statusCode, 401, `${method} ${r.url} must need sign-in`);
      else {
        assert.equal(res.statusCode, 302, `${method} ${r.url} must redirect to sign-in`);
        assert.match(res.headers.location, /^\/auth\/login\?next=/);
      }
      checked.push(`${method} ${r.url}`);
    }
  }
  // The check covers the whole app: postings, notes, prep, attachments, admin, inbox, pipeline, schedule, tasks, the page.
  for (const must of ['GET /api/postings', 'POST /api/postings/:id/meeting-prep', 'DELETE /api/notes/:id', 'GET /api/attachments/:id/file', 'PUT /api/admin/budget', 'POST /api/pipeline/run', 'POST /api/inbox/check', 'GET /api/schedule', 'GET /api/openapi.json']) {
    assert.ok(checked.includes(must), `${must} was checked`);
  }
  assert.ok(checked.some((c) => c.startsWith('GET /*') || c.startsWith('GET /')), 'the web page is checked');
  await app.close();
  store.close();
});

test('security headers on every response; HTTPS adds HSTS; a route with its own policy keeps it', async () => {
  const { app, store } = await fullApp({ authMode: 'none' });
  const res = await app.inject('/healthz');
  assert.equal(res.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'(;|$)/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  for (const [h, v] of [['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'same-origin'], ['cross-origin-opener-policy', 'same-origin']]) assert.equal(res.headers[h], v, h);
  assert.equal(res.headers['strict-transport-security'], undefined, 'no HSTS without HTTPS');
  assert.ok(!res.headers['x-powered-by']);

  const job = Number(store.db.prepare("INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at) VALUES (1, 'k', 'Example Co', 'CTO', 'example|cto', '2026-10-01', 'pipeline', 'new', 'x', 'x')").run().lastInsertRowid);
  const up = (await app.inject({ method: 'POST', url: `/api/postings/${job}/attachments`, headers: { 'content-type': 'application/octet-stream', 'x-filename': 'a.pdf', 'x-file-type': 'application/pdf' }, payload: Buffer.from('%PDF') })).json();
  const file = await app.inject(`/api/attachments/${up.id}/file`);
  assert.match(file.headers['content-security-policy'], /^sandbox/, 'attachments keep their sandbox policy');
  await app.close();
  store.close();

  const secure = await fullApp({ publicUrl: 'https://jobs.example.com' });
  assert.match((await secure.app.inject('/healthz')).headers['strict-transport-security'], /max-age=31536000/);
  await secure.app.close();
  secure.store.close();
});

test('rate limits: 30 sign-in requests per address per 15 minutes; an address with 100 refused requests is turned away', async () => {
  const { app, store } = await fullApp();
  for (let i = 0; i < 30; i += 1) assert.notEqual((await app.inject({ url: '/auth/login', remoteAddress: '203.0.113.5' })).statusCode, 429);
  const limited = await app.inject({ url: '/auth/login', remoteAddress: '203.0.113.5' });
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.notEqual((await app.inject({ url: '/auth/login', remoteAddress: '203.0.113.6' })).statusCode, 429, 'other addresses are not affected');

  for (let i = 0; i < 100; i += 1) assert.equal((await app.inject({ url: '/api/postings', remoteAddress: '198.51.100.7' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/postings', remoteAddress: '198.51.100.7' })).statusCode, 401, 'the 101st refusal is counted');
  assert.equal((await app.inject({ url: '/healthz', remoteAddress: '198.51.100.7' })).statusCode, 429, 'then everything is refused for a while');
  assert.equal((await app.inject({ url: '/healthz', remoteAddress: '198.51.100.8' })).statusCode, 200);
  await app.close();
  store.close();
});

test('rate limiter windows reset', () => {
  let t = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.deepEqual([limiter.hit('a').allowed, limiter.hit('a').allowed, limiter.hit('a').allowed], [true, true, false]);
  assert.equal(limiter.blocked('a'), true);
  t = 1000;
  assert.equal(limiter.blocked('a'), false);
  assert.equal(limiter.hit('a').allowed, true);
});

test('server errors never reveal internals; caller errors still say what is wrong', async () => {
  const logged = [];
  const { app, store } = await fullApp({ authMode: 'none', log: { error: (m) => logged.push(m), info() {}, warn() {} } });
  app.get('/api/test-boom', async () => {
    throw new Error('SQLITE_ERROR: no such table at C:\\secret\\path');
  });
  const boom = await app.inject('/api/test-boom');
  assert.equal(boom.statusCode, 500);
  assert.deepEqual(boom.json(), { error: 'Something went wrong on the server. The details are in the server log.' });
  assert.match(logged[0], /GET \/api\/test-boom: Error: SQLITE_ERROR/);
  const bad = await app.inject({ method: 'PATCH', url: '/api/postings/1', payload: { status: 42 } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /status/);
  assert.deepEqual(errorReply(Object.assign(new Error('Job not found'), { statusCode: 404 }), { method: 'GET', url: '/x' }), { status: 404, body: { error: 'Job not found' } });
  await app.close();
  store.close();
});
