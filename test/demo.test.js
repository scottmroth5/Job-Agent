// The public demo (AUTH_MODE=demo): read-only for every route, open without sign-in, its sample database, and the
// guards that keep the seed script away from a real job search. Sample data only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { assertSafeBinding, authSettings, DEMO_REFUSAL } from '../server/auth.js';
import { registerRateLimits } from '../server/security.js';
import { seedDemo, isDemoDatabase } from '../scripts/demo-seed.js';
import { DEMO_CONFIG, JOBS, SAMPLE_TASKS } from '../demo/sample-data.js';
import Fastify from 'fastify';

const NOW = new Date('2026-10-23T15:00:00Z');

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'demo-'));
  const dbPath = join(dir, 'job-agent.db');
  const configPath = join(dir, 'config', 'job-search.json');
  const counts = seedDemo({ dbPath, configPath, now: NOW });
  return { dir, dbPath, configPath, counts };
}

async function demoApp(dbPath) {
  const store = openJobStore(dbPath);
  const webDir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Job Hunt</title>');
  const app = await buildApp({
    store,
    config: DEMO_CONFIG,
    webDir,
    authMode: 'demo',
    auth: { settings: authSettings({ AUTH_MODE: 'demo', PUBLIC_URL: 'https://demo.example.com' }) },
    services: {
      claude: null,
      createBrowser: null,
      runPipeline: async () => assert.fail('the demo must never run the pipeline'),
      runScript: async () => assert.fail('the demo must never run a script'),
      inbox: { ready: () => false, gmail: () => assert.fail('no Gmail in the demo'), key: () => assert.fail('no key in the demo'), cfg: {} },
      knowledge: async () => '',
      sampleTasks: SAMPLE_TASKS,
      log: { info() {}, warn() {}, error() {} },
    },
  });
  return { app, store };
}

const sampleUrl = (url) => url.replace(/:(\w+)/g, (_, name) => (name === 'id' ? '1' : name === 'action' ? 'score' : name === 'list' ? 'status' : name === 'name' ? 'score' : 'x')).replaceAll('*', 'index.html');

test('the seed builds a full sample search: jobs in every stage, scores, letters, emails, runs, and prompt edits', () => {
  const { dbPath, configPath, counts } = seeded();
  assert.equal(counts.postings, JOBS.length);
  assert.ok(counts.runs > 10);
  const store = openJobStore(dbPath);
  const one = (sql) => store.db.prepare(sql).pluck().get();
  assert.ok(one("SELECT COUNT(*) FROM postings WHERE stage = 'pipeline'") >= 10);
  assert.ok(one("SELECT COUNT(*) FROM postings WHERE stage = 'discovered'") >= 5);
  assert.ok(one("SELECT COUNT(*) FROM postings WHERE stage = 'archived'") >= 5);
  assert.equal(one('SELECT COUNT(*) FROM postings p WHERE NOT EXISTS (SELECT 1 FROM scores s WHERE s.posting_id = p.id)'), 0);
  assert.ok(one("SELECT COUNT(*) FROM artifacts WHERE kind = 'cover_letter'") >= 10);
  assert.equal(one("SELECT COUNT(*) FROM emails WHERE review_status = 'needs_review'"), 1);
  assert.equal(one('SELECT COUNT(*) FROM meeting_preps'), 3, 'two interviews and the Arbor case');
  // No watch-out contradicts its job's location (the review's Yarrow finding): a location watch-out only on a job that has it.
  for (const r of store.db.prepare("SELECT p.workplace, s.analysis_json FROM scores s JOIN postings p ON p.id = s.posting_id WHERE s.user_id = @uid").all()) {
    const watch = JSON.parse(r.analysis_json).watchOuts ?? [];
    if (r.workplace !== 'hybrid') assert.ok(!watch.some((w) => /hybrid/i.test(w)), 'no hybrid watch-out on a ' + r.workplace + ' job');
    if (r.workplace !== 'onsite') assert.ok(!watch.some((w) => /onsite/i.test(w)), 'no onsite watch-out on a ' + r.workplace + ' job');
  }
  assert.equal(one('SELECT COUNT(*) FROM prompt_versions WHERE active = 1'), 2, 'the two sample prompt edits');
  // Every address and link is on a reserved example domain.
  for (const url of store.db.prepare('SELECT url FROM postings').pluck().all()) assert.match(url, /^https:\/\/jobs\.example\.com\//);
  for (const s of store.db.prepare('SELECT sender_domain FROM emails').pluck().all()) assert.match(s, /example(-recruiting)?\.com$/);
  store.close();
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), DEMO_CONFIG);
});

test('the seed only ever replaces a database it made', () => {
  const { dbPath } = seeded();
  assert.equal(isDemoDatabase(dbPath), true);
  const real = join(mkdtempSync(join(tmpdir(), 'real-')), 'job-agent.db');
  openJobStore(real).close();
  assert.equal(isDemoDatabase(real), false);
  assert.equal(isDemoDatabase(join(tmpdir(), 'no-such-dir', 'job-agent.db')), true);
});

test('demo mode refuses every request that would change data, without sign-in, except the prompt preview', async () => {
  const { dbPath } = seeded();
  const { app, store } = await demoApp(dbPath);
  await app.ready();
  const before = store.db.prepare('SELECT COUNT(*) FROM postings').pluck().get();
  const writes = [];
  for (const r of app.routeList) {
    for (const method of [r.method].flat()) {
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) continue;
      const url = sampleUrl(r.url);
      const res = await app.inject({ method, url, payload: { template: 'x', status: 'applied' }, remoteAddress: `10.1.${writes.length >> 8}.${writes.length & 255}` });
      if (/\/preview$/.test(r.url)) {
        assert.equal(res.statusCode, 200, 'the preview fills a draft and writes nothing');
      } else {
        assert.equal(res.statusCode, 403, `${method} ${r.url} must be refused in the demo`);
        assert.equal(res.json().error, DEMO_REFUSAL);
      }
      writes.push(`${method} ${r.url}`);
    }
  }
  for (const must of ['PATCH /api/postings/:id', 'POST /api/postings', 'POST /api/pipeline/run', 'POST /api/inbox/check', 'PUT /api/admin/prompts/:name', 'PUT /api/admin/budget', 'DELETE /api/notes/:id', 'POST /api/postings/:id/meeting-prep']) {
    assert.ok(writes.includes(must), `${must} was checked`);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM postings').pluck().get(), before);
  await app.close();
  store.close();
});

test('demo mode serves every screen without sign-in and says it is the demo', async () => {
  const { dbPath } = seeded();
  const { app, store } = await demoApp(dbPath);
  const me = (await app.inject('/api/me')).json();
  assert.deepEqual({ authMode: me.authMode, demo: me.demo }, { authMode: 'demo', demo: true });
  // The header names the sample candidate the way production names a signed-in person; an invented example.com address.
  assert.match(me.email, /^[a-z.]+@example\.com$/);
  assert.equal(me.name, 'Jordan Avery');
  for (const url of ['/api/summary', '/api/postings?stage=pipeline&status=all', '/api/postings/1', '/api/funnel', '/api/inbox', '/api/admin/prompts', '/api/admin/budget', '/api/lookups', '/api/pipeline', '/api/tasks', '/']) {
    assert.equal((await app.inject(url)).statusCode, 200, `${url} is open in the demo`);
  }
  const tasks = (await app.inject('/api/tasks')).json();
  assert.deepEqual(tasks.map((t) => t.kind).sort(), ['inbox', 'pipeline', 'score']);
  // Settings shows the sample candidate's About you and search, complete, so visitors see what scoring works from.
  const search = (await app.inject('/api/account/search')).json();
  assert.equal(search.demo, true);
  assert.ok(search.profile.length >= search.profileChars.min, 'a full About you');
  assert.deepEqual(search.problems, [], 'a complete search');
  assert.ok((await app.inject('/api/summary')).json().today.length > 0, 'Home has a Today list');
  await app.close();
  store.close();
});

test('demo mode on a public address needs an https PUBLIC_URL; on this computer it needs nothing', () => {
  assert.doesNotThrow(() => assertSafeBinding({ host: '127.0.0.1', mode: 'demo', settings: authSettings({ AUTH_MODE: 'demo' }) }));
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0', mode: 'demo', settings: authSettings({ AUTH_MODE: 'demo' }) }), /PUBLIC_URL/);
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0', mode: 'demo', settings: authSettings({ AUTH_MODE: 'demo', PUBLIC_URL: 'http://demo.example.com' }) }), /https/);
  assert.doesNotThrow(() => assertSafeBinding({ host: '0.0.0.0', mode: 'demo', settings: authSettings({ AUTH_MODE: 'demo', PUBLIC_URL: 'https://demo.example.com' }) }));
});

test('the demo caps every request per address, so a script cannot hammer the server', async () => {
  let t = 0;
  const app = Fastify();
  registerRateLimits(app, { all: { windowMs: 1000, max: 3 }, now: () => t });
  app.get('/x', async () => ({ ok: true }));
  app.get('/healthz', async () => ({ ok: true }));
  const codes = [];
  for (let i = 0; i < 5; i += 1) codes.push((await app.inject('/x')).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  assert.equal((await app.inject('/healthz')).statusCode, 200, 'health checks are never limited');
  t = 1001;
  assert.equal((await app.inject('/x')).statusCode, 200, 'the window resets');
});
