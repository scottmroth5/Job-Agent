// The durable job queue (v3 Phase 6, tools/queue/queue.ts): priority order, the interactive band, aging, reserved
// workers, per-user and one-at-a-time limits, dependencies, retries and dead letters, the crash sweep, turned-off types,
// isolation across users, running handlers as their user, timeouts, two workers never sharing a job, and retention.
// Runs on SQLite and on PostgreSQL (npm run test:pg). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { addUser } from '../db/users.ts';
import { currentUserId } from '../db/scope.ts';
import { createQueue, INTERACTIVE_BAND, NoRetry } from '../tools/queue/queue.ts';
/** @import { Db } from '../tools/types.ts' */

const T0 = Date.parse('2026-11-17T12:00:00.000Z');

async function setup() {
  const store = openJobStore(':memory:');
  await store.ready;
  const db = store.admin;
  let t = T0;
  const clock = { now: () => new Date(t), advance: (/** @type {number} */ ms) => { t += ms; } };
  const queue = createQueue({ db, now: clock.now, worker: 'w1', pollMs: 20, heartbeatMs: 50, sweepMs: 1_000_000, log: { info() {}, warn() {} } });
  const other = await addUser(db, { email: 'second@example.com' });
  return { store, db, queue, clock, other, done: () => store.close() };
}

/** @param {Db} db @param {string} pool @param {number} concurrency @param {number} perUser @param {number} reserved */
const pool = (db, pool, concurrency, perUser, reserved) =>
  db.prepare('UPDATE pool_settings SET concurrency = ?, per_user_concurrency = ?, reserved_for_interactive = ? WHERE pool = ?').run(concurrency, perUser, reserved, pool);
/** @param {Db} db @param {string} type @param {Record<string, unknown>} fields */
const setType = async (db, type, fields) => {
  for (const [k, v] of Object.entries(fields)) await db.prepare(`UPDATE task_types SET ${k} = ? WHERE id = ?`).run(v, type);
};

test('higher priority first, oldest first among equals; a user\'s own request runs in the band above all scheduled work', async () => {
  const { db, queue, clock, done } = await setup();
  try {
    await pool(db, 'ai', 10, 10, 0);
    await setType(db, 'add-score', { priority: 30 }); // a lower priority than score's 50, with no one-at-a-time rule
    const a = await queue.enqueue('score', { n: 1 }, { userId: 1 });
    clock.advance(1000);
    const b = await queue.enqueue('add-score', { n: 2 }, { userId: 1 });
    clock.advance(1000);
    const c = await queue.enqueue('score', { n: 3 }, { userId: 1 });
    clock.advance(1000);
    const d = await queue.enqueue('add-score', { n: 4 }, { userId: 1, interactive: true });
    assert.equal((await queue.get(d.id, 1))?.priority, 30 + INTERACTIVE_BAND);
    const order = [];
    for (let i = 0; i < 4; i += 1) order.push((await queue.claim('ai'))?.id);
    assert.deepEqual(order, [d.id, a.id, c.id, b.id]);
    assert.equal(await queue.claim('ai'), null);
  } finally {
    done();
  }
});

test('aging raises waiting scheduled work one level per aging_minutes, capped below the interactive band', async () => {
  const { db, queue, clock, done } = await setup();
  try {
    await pool(db, 'io', 1, 1, 0);
    await setType(db, 'backup', { aging_minutes: 10 }); // priority 20
    const old = await queue.enqueue('backup', null, { userId: 1 });
    clock.advance(5 * 60_000);
    const fresh = await queue.enqueue('inbox', null, { userId: 1 }); // priority 40
    clock.advance(25 * 60_000); // backup has waited 30 minutes: 20 + 3 = 23 < 40
    assert.equal((await queue.claim('io'))?.id, fresh.id);
    await queue.complete(fresh.id, null);
    // Waiting long enough, aging stops just below the interactive band.
    await queue.enqueue('inbox', null, { userId: 1 });
    clock.advance(100_000 * 60_000);
    assert.equal((await queue.claim('io'))?.id, old.id, 'after a very long wait the backup outranks fresh scheduled work');
    const urgent = await queue.enqueue('backup', null, { userId: 1, interactive: true });
    await queue.complete(old.id, null);
    assert.equal((await queue.claim('io'))?.id, urgent.id, 'but never a user\'s own request');
  } finally {
    done();
  }
});

test('reserved workers take only interactive work; running jobs are never interrupted', async () => {
  const { db, queue, done } = await setup();
  try {
    await pool(db, 'ai', 2, 2, 1);
    await queue.enqueue('score', null, { userId: 1 });
    await queue.enqueue('score', null, { userId: 1 });
    assert.ok(await queue.claim('ai'), 'the first scheduled job takes the unreserved worker');
    assert.equal(await queue.claim('ai'), null, 'the second may not take the reserved one');
    const mine = await queue.enqueue('score', null, { userId: 1, interactive: true });
    assert.equal((await queue.claim('ai'))?.id, mine.id, 'a user\'s own request may');
    assert.equal(await queue.claim('ai'), null, 'the pool is full');
  } finally {
    done();
  }
});

test('per-user limits share a pool fairly; one-at-a-time holds per user or across the app', async () => {
  const { db, queue, clock, other, done } = await setup();
  try {
    await pool(db, 'ai', 3, 1, 0);
    await queue.enqueue('score', null, { userId: 1 });
    clock.advance(1000);
    await queue.enqueue('score', null, { userId: 1 });
    clock.advance(1000);
    const theirs = await queue.enqueue('score', null, { userId: other });
    assert.equal((await queue.claim('ai'))?.userId, 1);
    assert.equal((await queue.claim('ai'))?.id, theirs.id, 'the owner\'s second job waits; the other user\'s runs');
    assert.equal(await queue.claim('ai'), null);

    await pool(db, 'io', 5, 5, 0);
    await queue.enqueue('inbox', null, { userId: 1 }); // one at a time per user
    await queue.enqueue('inbox', null, { userId: 1 });
    await queue.enqueue('inbox', null, { userId: other });
    await queue.enqueue('pipeline', null, { userId: 1 }); // one at a time across the app
    await queue.enqueue('pipeline', null, { userId: other });
    const started = [];
    for (let job = await queue.claim('io'); job; job = await queue.claim('io')) started.push(`${job.type}:${job.userId === 1 ? 'owner' : 'other'}`);
    assert.deepEqual(started.filter((s) => s.startsWith('inbox')).sort(), ['inbox:other', 'inbox:owner'], 'one inbox check per user');
    assert.equal(started.filter((s) => s.startsWith('pipeline')).length, 1, 'one pipeline across the app');
  } finally {
    done();
  }
});

test('a job that depends on another waits until it finishes, whatever its result', async () => {
  const { db, queue, done } = await setup();
  try {
    await pool(db, 'io', 5, 5, 0);
    await pool(db, 'ai', 5, 5, 0);
    const first = await queue.enqueue('pipeline-archive', null, { userId: 1 });
    const second = await queue.enqueue('pipeline-score', null, { userId: 1, dependsOn: first.id });
    assert.equal(await queue.claim('ai'), null, 'its dependency has not finished');
    const job = await queue.claim('io');
    assert.equal(job?.id, first.id);
    await queue.fail(/** @type {import('../tools/queue/queue.ts').Job} */ (job), new Error('archive failed'));
    assert.equal((await queue.claim('ai'))?.id, second.id, 'a failed step still lets the next one start, as the pipeline does today');
  } finally {
    done();
  }
});

test('a parent waiting on its child tasks holds no worker, so its children in the same pool can start; the list leaves children out', async () => {
  const { db, queue, done } = await setup();
  try {
    await pool(db, 'io', 1, 1, 0);
    const parent = await queue.enqueue('pipeline', null, { userId: 1 });
    assert.equal((await queue.claim('io'))?.id, parent.id);
    const child = await queue.enqueue('pipeline-archive', null, { userId: 1, parentId: parent.id });
    assert.equal((await queue.claim('io'))?.id, child.id, 'the parent waits on it, so its worker slot is free');
    const other = await queue.enqueue('backup', null, { userId: 1 });
    assert.equal(await queue.claim('io'), null, 'the child holds the one worker');
    await queue.complete(child.id, null);
    assert.equal(await queue.claim('io'), null, 'with no child waiting, the parent holds its worker again');
    assert.deepEqual((await queue.list(1)).map((j) => j.id).sort(), [other.id, parent.id].sort(), 'the child shows in its parent, not the list');
  } finally {
    done();
  }
});

test('retries with backoff while the type allows, then a dead letter; no retry for AI types or NoRetry', async () => {
  const { db, queue, clock, done } = await setup();
  try {
    await pool(db, 'browser', 5, 5, 0);
    const r = await queue.enqueue('refetch', null, { userId: 1 }); // retry_limit 1
    let job = await queue.claim('browser');
    await queue.fail(/** @type {any} */ (job), new Error('timeout')); // any: a claimed job here, never null
    assert.equal((await queue.get(r.id, 1))?.status, 'queued');
    assert.equal(await queue.claim('browser'), null, 'not before its backoff');
    clock.advance(31_000);
    job = await queue.claim('browser');
    assert.equal(job?.attempts, 2);
    await queue.fail(/** @type {any} */ (job), new Error('timeout again'));
    const dead = await queue.get(r.id, 1);
    assert.deepEqual([dead?.status, dead?.error], ['dead', 'timeout again']);
    assert.ok(await queue.retry(r.id), 'the admin can retry a dead letter');
    assert.equal((await queue.get(r.id, 1))?.status, 'queued');
    assert.ok(await queue.discard(r.id), '... or discard it');
    assert.equal((await queue.get(r.id, 1))?.status, 'cancelled');

    await pool(db, 'ai', 5, 5, 0);
    const ai = await queue.enqueue('write-materials', null, { userId: 1 }); // retry_limit 0: a repeat costs money
    await queue.fail(/** @type {any} */ (await queue.claim('ai')), new Error('Claude said no'));
    assert.equal((await queue.get(ai.id, 1))?.status, 'failed');
    const once = await queue.enqueue('refetch', null, { userId: 1 });
    await queue.fail(/** @type {any} */ (await queue.claim('browser')), new NoRetry('bad link'));
    assert.equal((await queue.get(once.id, 1))?.status, 'dead');
  } finally {
    done();
  }
});

test('the sweep retries or fails a job whose worker stopped, and closes its run', async () => {
  const { db, queue, clock, done } = await setup();
  try {
    await pool(db, 'io', 5, 5, 0);
    await pool(db, 'ai', 5, 5, 0);
    const retried = await queue.enqueue('inbox', null, { userId: 1 }); // retry_limit 1
    const failed = await queue.enqueue('score', null, { userId: 1 }); // retry_limit 0
    await queue.claim('io');
    await queue.claim('ai');
    const runId = /** @type {number} */ ((await db.prepare("INSERT INTO runs (name, started_at, status, user_id) VALUES ('ui-score', ?, 'running', 1) RETURNING id").run(new Date(T0).toISOString())).id);
    await db.prepare('UPDATE task_runs SET run_id = ? WHERE id = ?').run(runId, failed.id);
    clock.advance(60_000);
    assert.equal(await queue.sweep(), 0, 'heartbeats are recent enough');
    clock.advance(120_000);
    assert.equal(await queue.sweep(), 2);
    assert.equal((await queue.get(retried.id, 1))?.status, 'queued');
    const f = await queue.get(failed.id, 1);
    assert.deepEqual([f?.status, f?.error], ['failed', 'The worker stopped before this task finished.']);
    assert.equal(await db.prepare('SELECT status FROM runs WHERE id = ?').pluck().get(runId), 'failed');
  } finally {
    done();
  }
});

test('a turned-off type refuses a user\'s request and records a scheduled one as skipped', async () => {
  const { db, queue, done } = await setup();
  try {
    await setType(db, 'score', { enabled: 0 });
    await assert.rejects(queue.enqueue('score', null, { userId: 1, interactive: true }), (/** @type {Error & { statusCode?: number }} */ err) => err.statusCode === 409 && /turned off/.test(err.message));
    const s = await queue.enqueue('score', null, { userId: 1 });
    assert.equal(s.status, 'skipped');
    assert.equal(await queue.claim('ai'), null);
  } finally {
    done();
  }
});

test('each user sees only their own tasks and lines', async () => {
  const { queue, other, done } = await setup();
  try {
    const mine = await queue.enqueue('score', { postingId: 1 }, { userId: 1 });
    await queue.enqueue('score', { postingId: 2 }, { userId: other });
    assert.equal((await queue.list(1)).length, 1);
    assert.equal(await queue.get(mine.id, other), null);
    assert.deepEqual(await queue.lines(mine.id, other), { lines: [], next: 0 });
  } finally {
    done();
  }
});

test('workers run each handler as its user, keep its output and steps, and time it out', async () => {
  const { db, done, other } = await setup();
  const queue = createQueue({ db, worker: 'w2', pollMs: 10, heartbeatMs: 20, sweepMs: 1_000_000, log: { info() {}, warn() {} } });
  await pool(db, 'ai', 5, 5, 0);
  await setType(db, 'find-contact', { timeout_seconds: 1 });
  const workers = queue.start({
    score: async ({ step, logger, job }) => {
      step('Scoring');
      logger.info('line one\nline two');
      step('Step 2/5: score', { log: false });
      return { as: currentUserId(), payload: job.payload };
    },
    'find-contact': async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('gave up')))),
  });
  try {
    const a = await queue.enqueue('score', { postingId: 7 }, { userId: other, interactive: true });
    const slow = await queue.enqueue('find-contact', null, { userId: 1, interactive: true });
    const finished = await queue.wait(a.id, other, 5000, 20);
    assert.equal(finished?.status, 'done');
    assert.deepEqual(finished?.result, { as: other, payload: { postingId: 7 } }, 'ran as its user, with its payload');
    assert.deepEqual((await queue.steps(a.id, other)).map((s) => s.message), ['Scoring', 'Step 2/5: score']);
    const out = await queue.lines(a.id, other);
    assert.deepEqual(out.lines.map((l) => l.text), ['Scoring', 'line one', 'line two'], 'a progress-only step is not an output line');
    assert.equal(await queue.lineCount(a.id, other), 3);
    const timedOut = await queue.wait(slow.id, 1, 5000, 50);
    assert.equal(timedOut?.status, 'failed');
    assert.match(String(timedOut?.error), /Timed out after 1 seconds/);
  } finally {
    await workers.stop();
    done();
  }
});

test('two workers claiming at once never take the same job', async () => {
  const { db, queue, done } = await setup();
  try {
    await pool(db, 'ai', 50, 50, 0);
    for (let i = 0; i < 20; i += 1) await queue.enqueue('score', { i }, { userId: 1 });
    const second = createQueue({ db, worker: 'w3', log: { info() {}, warn() {} } });
    const claims = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? queue : second).claim('ai')));
    const ids = claims.filter(Boolean).map((j) => j?.id);
    assert.equal(ids.length, 20);
    assert.equal(new Set(ids).size, 20, 'every job handed out once');
  } finally {
    done();
  }
});

test('finished jobs and their lines go after the retention period', async () => {
  const { db, queue, clock, done } = await setup();
  try {
    await pool(db, 'ai', 5, 5, 0);
    const old = await queue.enqueue('score', null, { userId: 1 });
    const job = await queue.claim('ai');
    await db.prepare("INSERT INTO task_lines (task_id, user_id, seq, at, level, text) VALUES (?, 1, 0, 'x', 'info', 'hello')").run(job?.id);
    await queue.complete(old.id, { ok: true });
    clock.advance(31 * 86_400_000);
    const recent = await queue.enqueue('score', null, { userId: 1 });
    assert.equal(await queue.prune(30), 1);
    assert.equal(await queue.get(old.id, 1), null);
    assert.equal(await db.prepare('SELECT COUNT(*) FROM task_lines WHERE task_id = ?').pluck().get(old.id), 0);
    assert.ok(await queue.get(recent.id, 1), 'waiting work is never pruned');
  } finally {
    done();
  }
});
