// The process roles (v3 Phase 7, PR 2): the API, the workers, and the scheduler as processes of their own on one
// database. The API only enqueues; worker processes run the pools they are given (an added job's two halves in two
// workers); a stopping worker gives running tasks its grace period, then requeues the ones that may retry and fails the
// rest visibly; the scheduler picks up a saved change; alerts become notify tasks. Runs on SQLite and on PostgreSQL
// (npm run test:pg). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.ts';
import { addUser } from '../db/users.ts';
import { buildApp } from '../server/app.ts';
import { createJobs } from '../server/jobs.ts';
import { defineNotifyTasks, queuedAlerts } from '../server/tasks/notify.ts';
import { runScheduler } from '../server/scheduler-service.ts';
import { markAutomationChanged } from '../server/automatic-runs.ts';
import { saveAutomation } from '../agents/automation.ts';
import { graceMs, poolsFrom, workerService } from '../server/roles.ts';
import { createQueue, STOPPED_MESSAGE } from '../tools/queue/queue.ts';
import { parseSchedule } from '../tools/scheduler.ts';
import { repoPath } from '../tools/paths.ts';
import { fakeConfig, fakeServices } from './fixtures/fakes.js';
/** @import { ChildProcess } from 'node:child_process' */
/** @import { JobStore } from '../db/index.ts' */

const quiet = { info() {}, warn() {}, error() {} };
const DESCRIPTION = 'Lead the platform engineering team through a growth phase with hands on architecture reviews. '.repeat(3);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {() => Promise<boolean>} ok */
const until = async (ok, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await ok()) return true;
  return false;
};

test('POOLS and the grace periods', () => {
  assert.deepEqual(poolsFrom(undefined), ['browser', 'ai', 'io']);
  assert.deepEqual(poolsFrom('io, ai'), ['ai', 'io'], 'in the queue\'s order');
  assert.throws(() => poolsFrom('ai,gpu'), /"gpu" is not a pool/);
  assert.equal(workerService(['ai', 'io']), 'worker-ai-io');
  assert.deepEqual([graceMs('worker-ai', {}), graceMs('worker-browser', {}), graceMs('worker-browser-io', {}), graceMs('api', {}), graceMs('all', {})], [300_000, 120_000, 120_000, 30_000, 10_000]);
  assert.equal(graceMs('worker-ai', { SHUTDOWN_GRACE_SECONDS: '2' }), 2000);
});

test('a worker runs only its pools, keeps its row while it runs, and on a stop requeues or fails what the grace period did not cover', async () => {
  const store = openJobStore(':memory:');
  await store.ready;
  const db = store.admin;
  try {
    await db.prepare("UPDATE pool_settings SET concurrency = 5, per_user_concurrency = 5, reserved_for_interactive = 0").run();
    const queue = createQueue({ db, worker: 'w-io', pollMs: 20, heartbeatMs: 50, sweepMs: 1_000_000, log: quiet });
    const hang = /** @type {import('../tools/queue/queue.ts').Handler} */ (({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    const quick = await queue.enqueue('pipeline-archive', null, { userId: 1, interactive: true });
    const slowOnce = await queue.enqueue('backup', null, { userId: 1, interactive: true }); // retry_limit 1
    const slowNever = await queue.enqueue('pipeline', { by: 'button' }, { userId: 1, interactive: true }); // retry_limit 0
    const ai = await queue.enqueue('score', { id: 1 }, { userId: 1, interactive: true });
    const workers = queue.start({ 'pipeline-archive': async () => ({ ok: true }), backup: hang, pipeline: hang, score: async () => assert.fail('not this pool') }, { pools: ['io'], service: 'worker-io', version: 'test' });
    assert.ok(await until(async () => (await queue.get(quick.id, 1))?.status === 'done'));
    assert.ok(await until(async () => (await queue.get(slowNever.id, 1))?.status === 'running' && (await queue.get(slowOnce.id, 1))?.status === 'running'));
    assert.deepEqual((await queue.workers()).map((w) => [w.id, w.service, w.pools, w.version]), [['w-io', 'worker-io', ['io'], 'test']]);
    assert.ok(await until(async () => workers.healthy()), 'its row was renewed');
    assert.equal((await queue.get(ai.id, 1))?.status, 'queued', 'an ai task waits for an ai worker');

    await workers.stop(100); // the grace period runs out
    const once = await queue.get(slowOnce.id, 1);
    assert.deepEqual([once?.status, once?.attempts], ['queued', 0], 'may retry: back in the queue, the attempt not spent');
    const never = await queue.get(slowNever.id, 1);
    assert.deepEqual([never?.status, never?.error], ['failed', STOPPED_MESSAGE], 'may not retry: failed visibly');
    assert.ok((await queue.lines(slowNever.id, 1)).lines.some((l) => /stopped for an update/.test(l.text)));
    assert.deepEqual(await queue.workers(), [], 'its row is gone');
  } finally {
    store.close();
  }
});

test('a task that finishes within the grace period finishes', async () => {
  const store = openJobStore(':memory:');
  await store.ready;
  try {
    const queue = createQueue({ db: store.admin, pollMs: 20, heartbeatMs: 50, sweepMs: 1_000_000, log: quiet });
    const t = await queue.enqueue('backup', null, { userId: 1, interactive: true });
    let started = false;
    const workers = queue.start({ backup: async () => { started = true; await sleep(300); return { done: true }; } });
    assert.ok(await until(async () => started));
    await workers.stop(5000);
    assert.equal((await queue.get(t.id, 1))?.status, 'done');
  } finally {
    store.close();
  }
});

test('alerts become notify tasks: the io worker finds the owner address and sends', async () => {
  const store = openJobStore(':memory:');
  await store.ready;
  try {
    const jobs = createJobs({ store, ownerConfig: null, log: quiet, queueOptions: { pollMs: 20, sweepMs: 1_000_000 } });
    /** @type {Array<{ to: string, subject: string, text: string }>} */
    const sent = [];
    defineNotifyTasks({ jobs, mail: { to: () => 'owner@example.com', send: async (e) => sent.push(e) } });
    const alerts = queuedAlerts({ db: store.admin, jobs, appUrl: () => 'https://jobs.example.com', log: quiet });
    assert.equal(await alerts.jobResult('pipeline', false, 'Search was down'), true);
    assert.equal(await alerts.jobResult('pipeline', false, 'Again'), false, 'once a day');
    const [task] = await jobs.queue.list(1);
    assert.equal(task.type, 'notify');
    assert.equal(JSON.stringify(task.payload).includes('owner@example.com'), false, 'the address is not in the task');
    jobs.run({ pools: ['io'] });
    assert.ok(await until(async () => sent.length === 1));
    assert.equal(sent[0].to, 'owner@example.com');
    assert.match(sent[0].subject, /the scheduled pipeline failed/);
    await jobs.stop();
  } finally {
    store.close();
  }
});

test('the scheduler in its own process space takes a saved change within its check interval', async () => {
  const store = openJobStore(':memory:');
  await store.ready;
  const b = await addUser(store.admin, { email: 'b@example.com', status: 'active' });
  // A day three days off, so nothing comes due or catches up during the test.
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][(new Date().getDay() + 3) % 7];
  const scheduler = await runScheduler({ store, schedules: [{ name: 'pipeline', schedule: parseSchedule(`${day} 06:00`) }], log: quiet, timings: { changeMs: 50, syncMs: 3_600_000 } });
  try {
    const names = () => scheduler.runs.status().map((j) => j.name).sort();
    assert.deepEqual(names(), ['pipeline'], "the owner's default from SCHEDULE_PIPELINE");
    await saveAutomation(store.admin, b, { on: true, pipeline: `${day} 07:00` });
    await markAutomationChanged(store); // what the API's save does
    assert.ok(await until(async () => names().includes(`pipeline:${b}`), 5000), "B's runs appear without a restart");
  } finally {
    await scheduler.stop();
    store.close();
  }
});

/** A worker process (test/fixtures/role-worker.js) on the database file, for these pools. */
function startWorker(/** @type {string} */ path, /** @type {string} */ pools, env = {}) {
  const child = spawn(process.execPath, [repoPath('test', 'fixtures', 'role-worker.js'), path, pools], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'], env: { ...process.env, ...env } });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the ${pools} worker did not start`)), 60_000);
    child.stdout?.on('data', (d) => {
      const m = /ready (\d+)/.exec(String(d));
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once('exit', (code) => reject(new Error(`the ${pools} worker exited early (${code})`)));
  });
  return { child, ready: /** @type {Promise<number>} */ (ready) };
}
/**
 * Stops a worker as docker stop does (SIGTERM; an IPC message on Windows, which cannot catch it) and waits for it to exit.
 * One that has not exited in 30 seconds is killed (as docker stop does after its timeout), so a slow or stuck stop fails
 * the test's exit-code check instead of leaving a process that keeps the test run waiting forever.
 */
async function stopWorker(/** @type {ChildProcess} */ child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.removeAllListeners('exit');
  const exited = new Promise((r) => child.once('exit', r));
  if (process.platform === 'win32' && child.connected) child.send('stop');
  else child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  await exited;
  clearTimeout(timer);
}

/** A database file of its own (a schema of its own on PostgreSQL), with room for two tasks per user in each pool. */
async function sharedStore() {
  const dir = mkdtempSync(join(tmpdir(), 'roles-'));
  const path = join(dir, 'job-agent.db');
  const store = openJobStore(path);
  await store.ready;
  await store.admin.prepare('UPDATE pool_settings SET concurrency = 3, per_user_concurrency = 3, reserved_for_interactive = 0').run();
  return { store, path, done: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}

/** @param {JobStore} store */
const apiOnly = (store) =>
  buildApp({
    store,
    config: fakeConfig({ candidate: { name: 'Pat Example' }, search: { homeLocations: [] }, fractional: {}, coverLetterChecks: [] }),
    services: fakeServices({ claude: /** @type {any} */ ({}), knowledge: async () => '', http: null, createBrowser: null, log: quiet, queueOptions: { pollMs: 50 } }), // any: the API never calls Claude here; the route checks only that AI is on
    roles: { workers: false, scheduler: false },
  });

test('the API only enqueues: an added job is read in a browser worker and scored in an ai worker, each its own process', { timeout: 90_000 }, async () => {
  const { store, path, done } = await sharedStore();
  const browser = startWorker(path, 'browser');
  const ai = startWorker(path, 'ai');
  const app = await apiOnly(store);
  try {
    const [browserPort] = await Promise.all([browser.ready, ai.ready]);
    const health = await fetch(`http://127.0.0.1:${browserPort}/healthz`);
    assert.deepEqual([health.status, await health.json()], [200, { ok: true, service: 'worker-browser' }]);
    assert.deepEqual((await store.admin.prepare('SELECT service FROM workers ORDER BY service').pluck().all()), ['worker-ai', 'worker-browser']);

    const res = await app.inject({ method: 'POST', url: '/api/postings', payload: { title: 'Head of Engineering', company: 'Split Co', description: DESCRIPTION } });
    assert.equal(res.statusCode, 202);
    const id = res.json().taskId;
    assert.ok(await until(async () => (await app.inject(`/api/tasks/${id}`)).json().status !== 'running', 60_000), 'the task finished');
    const task = (await app.inject(`/api/tasks/${id}`)).json();
    assert.equal(task.status, 'done', `the task failed: ${task.error}`);
    assert.deepEqual([task.result.created, task.result.score], [true, 8]);
    assert.ok(task.steps.some((/** @type {{ message: string }} */ s) => /Scored 8 of 10/.test(s.message)), "the child's steps are the parent's");
    const ran = /** @type {Array<{ type: string, w: string }>} */ (await store.admin.prepare('SELECT t.type, w.service AS w FROM task_runs t LEFT JOIN workers w ON w.id = t.worker WHERE t.id = ? OR t.parent_id = ? ORDER BY t.created_at').all(id, id));
    assert.deepEqual(ran.map((r) => [r.type, r.w]), [['add', 'worker-browser'], ['add-score', 'worker-ai']]);
  } finally {
    await Promise.all([stopWorker(browser.child), stopWorker(ai.child)]);
    await app.close();
    done();
  }
});

test('a stopped worker (a deploy): the retryable task goes back in the queue, the other fails visibly, the API stays up', { timeout: 90_000 }, async () => {
  const { store, path, done } = await sharedStore();
  const worker = startWorker(path, 'browser', { SHUTDOWN_GRACE_SECONDS: '1' });
  const app = await apiOnly(store);
  try {
    await worker.ready;
    const posting = Number((await store.admin.prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, source, stage, status, track, discovered_on, created_at, updated_at)
      VALUES (1, 'https://jobs.example.com/9', 'https://jobs.example.com/9', 'Hang Co', 'CTO', 'hang', 'LinkedIn', 'pipeline', 'new', 'fulltime', '2026-11-19', 'x', 'x') RETURNING id`).run()).id);
    const refetch = (await app.inject({ method: 'POST', url: `/api/postings/${posting}/actions/refetch` })).json().taskId; // retry_limit 1; its fetch waits
    const queue = createQueue({ db: store.admin, log: quiet });
    const discover = (await queue.enqueue('pipeline-discover', { since: new Date().toISOString() }, { userId: 1, interactive: true })).id; // retry_limit 0
    assert.ok(await until(async () => (await queue.get(refetch, 1))?.status === 'running' && (await queue.get(discover, 1))?.status === 'running'), 'both started');

    await stopWorker(worker.child);
    assert.equal(worker.child.exitCode, 0, 'it stopped cleanly');
    const r = await queue.get(refetch, 1);
    assert.deepEqual([r?.status, r?.attempts], ['queued', 0], 'the refetch waits for the next browser worker, its attempt not spent');
    const d = await queue.get(discover, 1);
    assert.deepEqual([d?.status, d?.error], ['failed', STOPPED_MESSAGE], 'the discover step failed visibly');
    assert.deepEqual(await queue.workers(), [], 'its row is gone');
    assert.equal((await app.inject('/api/tasks')).statusCode, 200, 'the API answers throughout');
  } finally {
    await stopWorker(worker.child);
    await app.close();
    done();
  }
});
