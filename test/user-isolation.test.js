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
import { openJobStore } from '../db/index.js';
import { USER_TABLES } from '../db/migrations/013-users.js';
import { addUser, OWNER_ID } from '../db/users.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.js';
import { seedDemo } from '../scripts/demo-seed.js';
import { DEMO_CONFIG, JOBS, SAMPLE_TASKS } from '../demo/sample-data.js';

const SITE = 'http://localhost:5178';
// Strings only A's sample data holds: its companies.
const MARKERS = JOBS.map((j) => j.company);

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'isolation-'));
  const dbPath = join(dir, 'job-agent.db');
  seedDemo({ dbPath, configPath: join(dir, 'config', 'job-search.json'), now: new Date('2026-10-23T15:00:00Z') });
  const store = openJobStore(dbPath, { fallbackUid: null }); // as the server opens it: no user outside a request
  const B = addUser(store.raw, { email: 'b@example.com' });
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({
    AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'client.apps.example', GOOGLE_WEB_CLIENT_SECRET: 'secret',
    AUTH_ALLOWED_EMAILS: 'a@example.com, b@example.com', SESSION_SECRET: secret,
  });
  const webDir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Job Hunt</title>');
  const app = await buildApp({
    store,
    config: DEMO_CONFIG,
    webDir,
    authMode: 'google',
    auth: { settings, exchange: async () => assert.fail('no sign-in here') },
    services: {
      claude: null,
      createBrowser: null,
      runPipeline: async () => ({ code: 0, lastError: null }),
      runScript: async () => ({ code: 0, lastError: null }),
      inbox: { ready: () => false, gmail: () => assert.fail('no Gmail here'), key: () => null, cfg: {} },
      knowledge: async () => '',
      // Finished runs whose output names A's jobs (the owner's: they start outside any request).
      sampleTasks: SAMPLE_TASKS,
      log: { info() {}, warn() {}, error() {} },
    },
  });
  const cookie = (email) => `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`;
  return { store, app, B, asA: cookie('a@example.com'), asB: cookie('b@example.com') };
}

// A's ids, so B's requests aim at A's rows.
const fill = (url) => url.replace(/:(\w+)/g, (_, k) => ({ action: 'score', list: 'status', name: 'score', area: 'home' })[k] ?? '1').replaceAll('*', 'index.html');
// Task routes take a task id; A's sample tasks are 1 to N.
const urlsFor = (url) => (url.startsWith('/api/tasks/:id') ? SAMPLE_TASKS.map((_, i) => url.replace(':id', String(i + 1))) : [fill(url)]);
const snapshot = (db, uid) => JSON.stringify(USER_TABLES.map((t) => db.prepare(`SELECT * FROM "${t}" WHERE user_id = ? ORDER BY rowid`).all(uid)));

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

test('isolation: no write route sent by B changes any of A\'s rows', async () => {
  const { store, app, asB } = await setup();
  const before = snapshot(store.raw, OWNER_ID);
  const writes = app.routeList.filter((r) => ['PUT', 'PATCH', 'POST', 'DELETE'].includes(r.method) && r.url.startsWith('/api/'));
  assert.ok(writes.length >= 15, `the route table lists the write routes (${writes.length})`);
  // Plausible bodies for the routes that edit an existing row, so they get past validation and try A's row.
  const BODIES = {
    'PATCH /api/postings/:id': { status: 'passed', notes: 'Changed by B', title: 'Changed by B' },
    'POST /api/postings/:id/notes': { body: 'Changed by B' },
    'PUT /api/notes/:id': { body: 'Changed by B' },
    'PUT /api/admin/prompts/:name': { template: 'Changed by B {{candidateName}}' },
    'POST /api/inbox/reminders/:id/close': { status: 'done' },
  };
  for (const r of writes) {
    const body = BODIES[`${r.method} ${r.url}`] ?? (r.method === 'DELETE' ? undefined : {});
    await app.inject({ method: r.method, url: fill(r.url), headers: { cookie: asB, origin: SITE }, ...(body ? { payload: body } : {}) });
  }
  await new Promise((r) => setTimeout(r, 300)); // tasks the routes started finish
  assert.equal(snapshot(store.raw, OWNER_ID), before, "A's rows are unchanged");
  await app.close();
  store.close();
});

test('a paused or pending account gets no data, and a signed-in owner address with no row of its own is the owner', async () => {
  const { store, app, B, asA, asB } = await setup();
  store.raw.prepare("UPDATE users SET status = 'paused' WHERE id = ?").run(B);
  const res = await app.inject({ url: '/api/postings', headers: { cookie: asB } });
  assert.equal(res.statusCode, 403);
  assert.ok(!MARKERS.some((m) => res.body.includes(m)));
  assert.ok((await app.inject({ url: '/api/postings', headers: { cookie: asA } })).json().length >= 10);
  await app.close();
  store.close();
});

test('routes that use the owner\'s own accounts refuse everyone else, and every one of them exists', async () => {
  const { OWNER_ONLY } = await import('../server/app.js');
  const { store, app, asA, asB } = await setup();
  const routes = new Set(app.routeList.map((r) => `${r.method} ${r.url}`));
  for (const route of OWNER_ONLY) {
    assert.ok(routes.has(route), `${route} is a route`);
    const [method, url] = route.split(' ');
    const res = await app.inject({ method, url: fill(url), headers: { cookie: asB, origin: SITE }, payload: {} });
    assert.equal(res.statusCode, 403, `${route} as B`);
    assert.match(res.json().error, /Only the owner/);
  }
  // The owner gets past the check (to the route's own validation).
  const own = await app.inject({ method: 'POST', url: '/api/postings', headers: { cookie: asA, origin: SITE }, payload: {} });
  assert.notEqual(own.statusCode, 403);
  await app.close();
  store.close();
});
