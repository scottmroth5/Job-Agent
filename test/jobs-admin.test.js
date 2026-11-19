// Admin > Jobs (v3 Phase 6, PR 4): the queue's pools, task types and their history, dead letters, and totals, for
// admins only. Synthetic accounts and tasks; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openJobStore } from '../db/index.ts';
import { addUser, syncOwnerEmail } from '../db/users.ts';
import { buildApp } from '../server/app.ts';
import { authSettings } from '../server/auth.ts';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.ts';
import { INTERACTIVE_BAND } from '../tools/queue/queue.ts';
import { fakeConfig, fakeServices } from './fixtures/fakes.js';
/** @import { JsonRow } from './fixtures/fakes.js' */

const SITE = 'http://localhost:5178';
const OWNER = 'owner@example.com';

async function setup() {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: OWNER, SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  await syncOwnerEmail(store.admin, [OWNER]); // as server/main.ts does at start
  const app = await buildApp({
    store,
    config: fakeConfig({ candidate: { name: 'O' }, search: { homeLocations: [] }, fractional: {} }),
    authMode: 'google',
    auth: { settings },
    services: fakeServices({ createBrowser: async () => null, log: { info() {}, warn() {}, error() {} } }),
  });
  const as = (/** @type {string} */ email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE });
  const pat = await addUser(store.admin, { email: 'pat@example.com', name: 'Pat' });
  return { store, app, pat, asOwner: as(OWNER), asPat: as('pat@example.com'), done: async () => { await app.close(); store.close(); } };
}

test('Admin > Jobs is for admins only', async () => {
  const { app, asOwner, asPat, done } = await setup();
  for (const [method, url, payload] of /** @type {Array<[string, string, object | undefined]>} */ ([
    ['GET', '/api/admin/jobs', undefined],
    ['PATCH', '/api/admin/jobs/types/score', { priority: 10 }],
    ['PUT', '/api/admin/jobs/pools/ai', { concurrency: 3, perUser: 2, reserved: 1 }],
    ['POST', '/api/admin/jobs/tasks/x/retry', undefined],
    ['POST', '/api/admin/jobs/tasks/x/discard', undefined],
  ])) {
    const res = await app.inject({ method: /** @type {'GET'} */ (method), url, headers: asPat, ...(payload ? { payload } : {}) });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
  }
  const res = await app.inject({ url: '/api/admin/jobs', headers: asOwner });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.pools.map((/** @type {JsonRow} */ p) => p.pool), ['browser', 'ai', 'io']);
  assert.ok(body.types.some((/** @type {JsonRow} */ t) => t.id === 'pipeline-discover'));
  assert.ok(Array.isArray(body.workers), 'the worker processes online (v3 Phase 7)');
  await done();
});

test('task types: a change is saved with its history, a new priority can apply to waiting tasks, and bad values are refused', async () => {
  const { app, store, pat, asOwner, done } = await setup();
  const patch = (/** @type {object} */ payload) => app.inject({ method: 'PATCH', url: '/api/admin/jobs/types/backup', headers: asOwner, payload });
  // Two waiting backup tasks (no worker runs backups here: no runScript), one a user's own.
  const queue = app.jobs.queue;
  const scheduled = await queue.enqueue('backup', { id: 1 }, { userId: pat });
  const mine = await queue.enqueue('backup', { id: 2 }, { userId: pat, interactive: true });
  assert.equal((await patch({ priority: 2000 })).statusCode, 400, 'a priority in the interactive band is refused');
  assert.equal((await patch({ timeoutSeconds: 5 })).statusCode, 400);
  assert.equal((await patch({ retryLimit: 9 })).statusCode, 400);
  const ok = await patch({ priority: 70, retryLimit: 2, applyToWaiting: true });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { changed: ['priority', 'retry_limit'], requeued: 2 });
  const priorities = /** @type {JsonRow[]} */ (await store.admin.prepare('SELECT id, priority FROM task_runs WHERE type = ? ORDER BY priority').all('backup'));
  assert.deepEqual(priorities.map((/** @type {JsonRow} */ r) => [r.id, r.priority]), [[scheduled.id, 70], [mine.id, 70 + INTERACTIVE_BAND]]);
  assert.deepEqual((await patch({ priority: 70 })).json().changed, [], 'no change, no history');
  const body = (await app.inject({ url: '/api/admin/jobs', headers: asOwner })).json();
  assert.deepEqual(
    body.history.map((/** @type {JsonRow} */ h) => [h.typeId, h.field, h.oldValue, h.newValue, h.changedBy]).sort(),
    [['backup', 'priority', '20', '70', OWNER], ['backup', 'retry_limit', '1', '2', OWNER]].sort(),
  );
  // Turned off: a person's request is refused with a clear message.
  assert.equal((await patch({ enabled: false })).statusCode, 200);
  await assert.rejects(queue.enqueue('backup', null, { userId: pat, interactive: true }), /turned off/);
  await done();
});

test('pools: limits are checked and saved', async () => {
  const { app, asOwner, done } = await setup();
  const put = (/** @type {object} */ payload, pool = 'ai') => app.inject({ method: 'PUT', url: `/api/admin/jobs/pools/${pool}`, headers: asOwner, payload });
  assert.equal((await put({ concurrency: 0, perUser: 1, reserved: 0 })).statusCode, 400);
  assert.equal((await put({ concurrency: 2, perUser: 3, reserved: 0 })).statusCode, 400, 'per user above the workers');
  assert.equal((await put({ concurrency: 2, perUser: 1, reserved: 2 })).statusCode, 400, 'reserved must leave one for scheduled work');
  assert.equal((await put({ concurrency: 2, perUser: 1, reserved: 0 }, 'gpu')).statusCode, 400, 'no such pool');
  assert.equal((await put({ concurrency: 4, perUser: 2, reserved: 1 })).statusCode, 200);
  const ai = (await app.inject({ url: '/api/admin/jobs', headers: asOwner })).json().pools.find((/** @type {JsonRow} */ p) => p.pool === 'ai');
  assert.deepEqual([ai.concurrency, ai.perUser, ai.reserved], [4, 2, 1]);
  await done();
});

test('dead letters show kind, account, and error only, and can be retried or discarded; totals count tasks and their Claude cost', async () => {
  const { app, store, pat, asOwner, done } = await setup();
  const queue = app.jobs.queue;
  // Two tasks whose retries ran out (made dead directly: no worker runs backups here).
  const a = await queue.enqueue('backup', { id: 1, input: 'private request text' }, { userId: pat });
  const b = await queue.enqueue('backup', { id: 2 }, { userId: pat });
  await store.admin.prepare("UPDATE task_runs SET status = 'dead', error = 'The worker stopped before this task finished.', attempts = 2, finished_at = ? WHERE id IN (?, ?)").run(new Date().toISOString(), a.id, b.id);
  // A finished task whose traced run made a Claude call.
  const now = new Date();
  const done1 = await queue.record({ userId: pat, type: 'find-contact', startedAt: new Date(now.getTime() - 90_000), finishedAt: now });
  const run = await store.admin.prepare("INSERT INTO runs (name, status, started_at, user_id) VALUES ('ui-find-contact', 'ok', ?, ?) RETURNING id").run(now.toISOString(), pat);
  await store.admin.prepare("INSERT INTO run_calls (run_id, label, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at) VALUES (?, 'find-contact', 'm', 1, 1, 0, 0, 0.25, ?)").run(run.id, now.toISOString());
  await store.admin.prepare('UPDATE task_runs SET run_id = ? WHERE id = ?').run(run.id, done1);

  const body = (await app.inject({ url: '/api/admin/jobs', headers: asOwner })).json();
  assert.deepEqual(body.dead.map((/** @type {JsonRow} */ d) => d.user), ['pat@example.com', 'pat@example.com']);
  assert.deepEqual(Object.keys(body.dead[0]).sort(), ['attempts', 'createdAt', 'error', 'finishedAt', 'id', 'type', 'user']);
  assert.ok(!JSON.stringify(body).includes('private request text'), 'never what was asked');
  const contact = body.totals.find((/** @type {JsonRow} */ t) => t.type === 'find-contact');
  assert.deepEqual([contact.tasks, contact.done, contact.failed, contact.meanSeconds, contact.costUsd], [1, 1, 0, 90, 0.25]);
  const backup = body.totals.find((/** @type {JsonRow} */ t) => t.type === 'backup');
  assert.deepEqual([backup.tasks, backup.failed], [2, 2]);
  const io = body.pools.find((/** @type {JsonRow} */ p) => p.pool === 'io');
  assert.equal(io.failedToday, 2);

  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/jobs/tasks/${a.id}/retry`, headers: asOwner })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/jobs/tasks/${b.id}/discard`, headers: asOwner })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/jobs/tasks/${b.id}/discard`, headers: asOwner })).statusCode, 404, 'already discarded');
  const after = /** @type {JsonRow[]} */ (await store.admin.prepare('SELECT id, status, attempts FROM task_runs WHERE id IN (?, ?) ORDER BY status').all(a.id, b.id));
  assert.deepEqual(after.map((/** @type {JsonRow} */ r) => [r.id, r.status]), [[b.id, 'cancelled'], [a.id, 'queued']]);
  assert.equal((await app.inject({ url: '/api/admin/jobs', headers: asOwner })).json().dead.length, 0);
  await done();
});
