// The Phase 6 kill test: a worker process is killed (no shutdown, no cleanup) while two tasks run. Nothing is lost: a
// fresh worker's sweep finds both. The refetch (its type allows a retry) runs again and finishes, keeping the first
// attempt's output; the score task (Claude work never retries, so it cannot write a second letter or spend twice) fails
// visibly, saying the worker stopped, and its run is closed. Synthetic tasks in a throwaway database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.ts';
import { createQueue } from '../tools/queue/queue.ts';
import { repoPath } from '../tools/paths.ts';

test('a worker killed mid-task loses nothing: the retryable task runs again, the other fails visibly', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-kill-'));
  const path = join(dir, 'job-agent.db');
  const store = openJobStore(path);
  await store.ready;
  const db = store.admin;
  const setup = createQueue({ db, log: { info() {}, warn() {} } });
  const refetch = await setup.enqueue('refetch', { id: 1 }, { userId: 1, interactive: true });
  const score = await setup.enqueue('score', { id: 2 }, { userId: 1, interactive: true });

  const child = spawn(process.execPath, [repoPath('test', 'fixtures', 'queue-worker.js'), path], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the worker did not start both tasks')), 30_000);
      child.stdout.on('data', (d) => String(d).includes('running') && (clearTimeout(timer), resolve(null)));
      child.on('exit', (code) => reject(new Error(`the worker exited early (${code})`)));
    });
    child.removeAllListeners('exit');
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;

    const row = async (/** @type {string} */ id) => /** @type {{ status: string, attempts: number, error: string | null, run_id: number | null }} */ (await db.prepare('SELECT status, attempts, error, run_id FROM task_runs WHERE id = ?').get(id));
    assert.deepEqual([(await row(refetch.id)).status, (await row(score.id)).status], ['running', 'running'], 'killed mid-task: both still recorded as running');

    // A new worker (the restarted server): the sweep finds tasks whose heartbeat stopped.
    const fresh = createQueue({ db, worker: 'fresh', pollMs: 50, staleMs: 300, sweepMs: 200, retryDelayMs: 50, log: { info() {}, warn() {} } });
    const workers = fresh.start({
      refetch: async ({ logger }) => {
        logger.info('second attempt');
        return { fetchStatus: 'ok' };
      },
    });
    try {
      const done = await fresh.wait(refetch.id, 1, 15_000, 50);
      assert.equal(done?.status, 'done', 'the refetch ran again and finished');
      assert.equal(done?.attempts, 2);
      assert.deepEqual((await fresh.lines(refetch.id, 1)).lines.map((l) => l.text).filter((t) => !/^The worker stopped/.test(t)), ['working on refetch', 'second attempt'], 'the first attempt\'s output is kept');

      const failed = await fresh.wait(score.id, 1, 15_000, 50);
      assert.equal(failed?.status, 'failed', 'Claude work is never retried');
      assert.match(String(failed?.error), /worker stopped/);
      const run = /** @type {{ status: string, finished_at: string | null }} */ (await db.prepare('SELECT status, finished_at FROM runs WHERE id = ?').get((await row(score.id)).run_id));
      assert.equal(run.status, 'failed', "the score task's run is closed");
      assert.ok(run.finished_at);
    } finally {
      await workers.stop(2000);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
