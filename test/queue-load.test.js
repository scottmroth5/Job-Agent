// The Phase 6 load test: while long scheduled work fills every pool (a pipeline's steps, a backup, an inbox check, and
// a backlog of scoring), the tasks people start begin within 5 seconds: one in each pool, and a second Claude task from
// another account at the same time. The queue runs with its production timings (a 1 second poll, 15 second
// heartbeats) and the pool settings the migrations seed; the handlers only wait. Synthetic accounts; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { addUser } from '../db/users.ts';
import { createQueue } from '../tools/queue/queue.ts';

const TARGET_MS = 5000;
const LONG_MS = 12_000; // longer than the target, so no worker frees up in time by chance

test('tasks people start begin within 5 seconds while long scheduled work fills every pool', { timeout: 60_000 }, async () => {
  const store = openJobStore(':memory:');
  await store.ready;
  const db = store.admin;
  const queue = createQueue({ db, log: { info() {}, warn() {} } });
  const users = [1];
  for (const n of [2, 3, 4, 5]) users.push(await addUser(db, { email: `user${n}@example.com` }));
  /** @type {Set<() => void>} */
  const stops = new Set();
  const wait = (/** @type {number} */ ms, /** @type {AbortSignal} */ signal) =>
    new Promise((/** @type {(v?: unknown) => void} */ resolve) => {
      const timer = setTimeout(resolve, ms);
      const stop = () => (clearTimeout(timer), resolve());
      stops.add(stop);
      signal.addEventListener('abort', stop, { once: true });
    });
  /** @type {Record<string, import('../tools/queue/queue.ts').Handler>} */
  const handlers = {};
  const quick = ['refetch', 'score', 'find-contact', 'pipeline'];
  for (const type of ['pipeline-discover', 'pipeline-score', 'backup', 'inbox', 'score', 'refetch', 'find-contact', 'pipeline']) {
    handlers[type] = async ({ signal }) => wait(LONG_MS, signal); // a letter or a prep takes a minute or more: as long as the rest
  }
  const workers = queue.start(handlers);
  try {
    // The long scheduled work: the owner's pipeline steps (discover in the browser pool, scoring in Claude's), a
    // backup and an inbox check (outside services), and other accounts' scoring backlog.
    await queue.enqueue('pipeline-discover', null, { userId: users[0] });
    await queue.enqueue('pipeline-score', null, { userId: users[1] });
    await queue.enqueue('backup', null, { userId: users[0] });
    await queue.enqueue('inbox', null, { userId: users[0] });
    for (const uid of [users[1], users[2], users[1], users[2], users[3], users[4]]) await queue.enqueue('score', null, { userId: uid });
    // Let the scheduled work take every worker it may.
    await new Promise((r) => setTimeout(r, 2500));
    const running = Number(await db.prepare("SELECT COUNT(*) FROM task_runs WHERE status = 'running'").pluck().get());
    assert.ok(running >= 3, `scheduled work is running in every pool (${running})`);

    // Then people press buttons: a refetch (browser), two Claude tasks from different accounts, and a pipeline (io).
    const started = [
      await queue.enqueue('refetch', { id: 1 }, { userId: users[2], interactive: true }),
      await queue.enqueue('score', { id: 2 }, { userId: users[3], interactive: true }),
      await queue.enqueue('find-contact', { id: 3 }, { userId: users[4], interactive: true }),
      await queue.enqueue('pipeline', null, { userId: users[3], interactive: true }),
    ];
    const deadline = Date.now() + TARGET_MS + 2000;
    /** @type {Record<string, number | null>} */
    const waits = {};
    for (;;) {
      for (const [i, s] of started.entries()) {
        const job = await queue.get(s.id, Number(await queue.ownerOf(s.id)));
        if (job?.startedAt && waits[quick[i]] == null) waits[quick[i]] = Date.parse(job.startedAt) - Date.parse(job.createdAt);
      }
      if (Object.keys(waits).length === started.length || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const type of quick) assert.ok(waits[type] != null && /** @type {number} */ (waits[type]) <= TARGET_MS, `${type} started in ${waits[type] ?? 'more than 7000'} ms (target ${TARGET_MS})`);
    console.log(`[load] waits to start, ms: ${quick.map((t) => `${t} ${waits[t]}`).join(', ')}`);
  } finally {
    for (const stop of stops) stop();
    await workers.stop(2000);
    store.close();
  }
});
