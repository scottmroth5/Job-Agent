// Multi-user guard (phase 1), the behavioral half: with user A's (the owner's) data in the database, user B (signed in,
// with their own users row) sees none of it on any GET route, and no write route sent by B changes any of A's rows.
// Routes come from the app's own route table, so a new route is covered without editing this test. The demo's made-up
// sample data only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.ts';
import { USER_TABLES } from '../db/user-tables.ts';
import { addUser, OWNER_ID } from '../db/users.ts';
import { buildApp } from '../server/app.ts';
import { authSettings } from '../server/auth.ts';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.ts';
import { seedDemo } from '../scripts/demo-seed.js';
import { DEMO_CONFIG, JOBS, SAMPLE_TASKS } from '../demo/sample-data.ts';
import { fakeServices } from './fixtures/fakes.js';
/** @import { AppServices } from '../server/app.ts' */
/** @import { Database } from '../tools/types.ts' */
/** @import { InjectOptions } from 'fastify' */

const SITE = 'http://localhost:5178';
// Strings only A's sample data holds: its companies.
const MARKERS = JOBS.map((j) => j.company);

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'isolation-'));
  const dbPath = join(dir, 'job-agent.db');
  await seedDemo({ dbPath, configPath: join(dir, 'config', 'job-search.json'), now: new Date('2026-10-23T15:00:00Z') });
  const store = openJobStore(dbPath, { fallbackUid: null }); // as the server opens it: no user outside a request
  const B = await addUser(store.raw, { email: 'b@example.com' });
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({
    AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'client.apps.example', GOOGLE_WEB_CLIENT_SECRET: 'secret',
    AUTH_ALLOWED_EMAILS: 'a@example.com', SESSION_SECRET: secret,
  });
  const webDir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Job Hunt</title>');
  const app = await buildApp({
    store,
    config: DEMO_CONFIG,
    webDir,
    authMode: 'google',
    auth: { settings, exchange: async () => assert.fail('no sign-in here') },
    services: fakeServices({
      claude: null,
      createBrowser: null,
      runPipeline: async () => ({ code: 0, lastError: null }),
      runScript: async () => ({ code: 0, lastError: null }),
      // Gmail is never reached: ready() says it is not signed in.
      inbox: /** @type {NonNullable<AppServices['inbox']>} */ (/** @type {unknown} */ ({ ready: () => false, gmail: () => assert.fail('no Gmail here'), key: () => null, cfg: {} })),
      knowledge: async () => '',
      // Finished runs whose output names A's jobs (the owner's: they start outside any request).
      sampleTasks: SAMPLE_TASKS,
      log: { info() {}, warn() {}, error() {} },
    }),
  });
  const cookie = (/** @type {string} */ email) => `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`;
  return { store, app, B, asA: cookie('a@example.com'), asB: cookie('b@example.com') };
}

// A's ids, so B's requests aim at A's rows.
/** @type {Record<string, string>} */
const PARAMS = { action: 'score', list: 'status', name: 'score', area: 'home' };
const fill = (/** @type {string} */ url) => url.replace(/:(\w+)/g, (_, /** @type {string} */ k) => PARAMS[k] ?? '1').replaceAll('*', 'index.html');
// Task routes take a task id; A's sample tasks are 1 to N.
const urlsFor = (/** @type {string} */ url) => (url.startsWith('/api/tasks/:id') ? SAMPLE_TASKS.map((_, i) => url.replace(':id', String(i + 1))) : [fill(url)]);
const snapshot = (/** @type {Database} */ db, /** @type {number} */ uid) => JSON.stringify(USER_TABLES.map((t) => db.prepare(`SELECT * FROM "${t}" WHERE user_id = ? ORDER BY rowid`).all(uid)));

test('isolation: B sees none of A\'s jobs on any GET route; A sees them', async () => {
  const { store, app, asA, asB } = await setup();
  const gets = app.routeList.filter((r) => r.method === 'GET' && r.url.startsWith('/api/') && r.url !== '/api/openapi.json');
  assert.ok(gets.length >= 15, `the route table lists the GET routes (${gets.length})`);
  const seenByA = new Set();
  for (const r of gets) {
    for (const url of urlsFor(r.url)) {
      const bodyB = (await app.inject({ url, headers: { cookie: asB } })).body;
      for (const m of MARKERS) assert.ok(!bodyB.includes(m), `${url} shows A's "${m}" to B`);
      const bodyA = (await app.inject({ url, headers: { cookie: asA } })).body;
      for (const m of MARKERS) if (bodyA.includes(m)) seenByA.add(m);
    }
  }
  assert.ok(seenByA.size >= 10, `A sees their own jobs (${seenByA.size})`);
  assert.equal((await app.inject({ url: '/api/tasks', headers: { cookie: asB } })).json().length, 0, "B's task list is empty");
  assert.equal((await app.inject({ url: '/api/tasks', headers: { cookie: asA } })).json().length, SAMPLE_TASKS.length);
  await app.close();
  store.close();
});

test("the summary's spend and last run are each user's own; the owner's include runs from before runs had a user", async () => {
  const { store, app, B, asA, asB } = await setup();
  const at = new Date().toISOString();
  const run = (/** @type {number | null} */ uid, /** @type {number} */ cost) => store.raw.prepare("INSERT INTO runs (name, status, started_at, cost_usd, user_id) VALUES ('pipeline', 'ok', ?, ?, ?)").run(at, cost, uid);
  const summary = async (/** @type {string} */ cookie) => (await app.inject({ url: '/api/summary', headers: { cookie } })).json();
  const before = await summary(asA);
  assert.deepEqual([(await summary(asB)).spend30Days, (await summary(asB)).lastRun], [0, null], 'B has no runs yet');
  run(OWNER_ID, 2);
  run(null, 1);
  assert.deepEqual([(await summary(asB)).spend30Days, (await summary(asB)).lastRun], [0, null], "A's runs are not B's");
  assert.equal((await summary(asA)).spend30Days, before.spend30Days + 3);
  run(B, 0.5);
  const b = await summary(asB);
  assert.equal(b.spend30Days, 0.5);
  assert.equal(b.lastRun.name, 'pipeline');
  assert.equal((await summary(asA)).spend30Days, before.spend30Days + 3, "B's run is not A's");
  await app.close();
  store.close();
});

test('isolation: no write route sent by B changes any of A\'s rows', async () => {
  const { store, app, asB } = await setup();
  const before = snapshot(store.raw, OWNER_ID);
  const writes = app.routeList.filter((r) => ['PUT', 'PATCH', 'POST', 'DELETE'].includes(/** @type {string} */ (r.method)) && r.url.startsWith('/api/'));
  assert.ok(writes.length >= 15, `the route table lists the write routes (${writes.length})`);
  // Plausible bodies for the routes that edit an existing row, so they get past validation and try A's row.
  /** @type {Record<string, object>} */
  const BODIES = {
    'PATCH /api/postings/:id': { status: 'passed', notes: 'Changed by B', title: 'Changed by B' },
    'POST /api/postings/:id/notes': { body: 'Changed by B' },
    'PUT /api/notes/:id': { body: 'Changed by B' },
    'PUT /api/prompts/:name': { template: 'Changed by B {{candidateName}}' },
    'POST /api/inbox/reminders/:id/close': { status: 'done' },
  };
  for (const r of writes) {
    const body = BODIES[`${r.method} ${r.url}`] ?? (r.method === 'DELETE' ? undefined : {});
    await app.inject({ method: /** @type {InjectOptions['method']} */ (r.method), url: fill(r.url), headers: { cookie: asB, origin: SITE }, ...(body ? { payload: body } : {}) });
  }
  await new Promise((r) => setTimeout(r, 300)); // tasks the routes started finish
  assert.equal(snapshot(store.raw, OWNER_ID), before, "A's rows are unchanged");
  await app.close();
  store.close();
});

test('a paused account can look at its own data but change nothing; a pending one gets nothing', async () => {
  const { store, app, B, asA, asB } = await setup();
  store.raw.prepare("UPDATE users SET status = 'paused' WHERE id = ?").run(B);
  const look = await app.inject({ url: '/api/postings', headers: { cookie: asB } });
  assert.deepEqual([look.statusCode, look.json()], [200, []]);
  const change = await app.inject({ method: 'PUT', url: '/api/layout/home', headers: { cookie: asB, origin: SITE }, payload: { order: ['inbox'] } });
  assert.equal(change.statusCode, 403);
  assert.match(change.json().error, /paused/);
  store.raw.prepare("UPDATE users SET status = 'pending' WHERE id = ?").run(B);
  const pending = await app.inject({ url: '/api/postings', headers: { cookie: asB } });
  assert.deepEqual([pending.statusCode, pending.json().account], [403, 'pending']);
  assert.ok(!MARKERS.some((m) => pending.body.includes(m)));
  assert.ok((await app.inject({ url: '/api/postings', headers: { cookie: asA } })).json().length >= 10);
  await app.close();
  store.close();
});

test('routes that use the owner\'s own accounts refuse everyone else, and every one of them exists', async () => {
  const { OWNER_ONLY } = await import('../server/app.ts');
  const { store, app, asA, asB } = await setup();
  const routes = new Set(app.routeList.map((r) => `${r.method} ${r.url}`));
  for (const route of OWNER_ONLY) {
    assert.ok(routes.has(route), `${route} is a route`);
    const [method, url] = route.split(' ');
    const res = await app.inject({ method: /** @type {InjectOptions['method']} */ (method), url: fill(url), headers: { cookie: asB, origin: SITE }, payload: {} });
    assert.equal(res.statusCode, 403, `${route} as B`);
    assert.match(res.json().error, /Only the owner/);
  }
  // The owner gets past the check (to the route's own validation).
  const own = await app.inject({ method: 'POST', url: '/api/postings', headers: { cookie: asA, origin: SITE }, payload: {} });
  assert.notEqual(own.statusCode, 403);
  await app.close();
  store.close();
});
