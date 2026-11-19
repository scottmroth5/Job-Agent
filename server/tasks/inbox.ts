// The inbox check as a task (v3 Phase 7: moved here from server/inbox-routes.ts, which only enqueues), and
// inboxStarter, the one way to start one: the Inbox screen's Check now and the scheduler both call it.
import { createJobTracer } from '../../tools/trace.ts';
import { assertNoRunningRun } from '../../tools/runs.ts';
import { currentUserId } from '../../db/scope.ts';
import { OWNER_ID } from '../../db/users.ts';
import { runInbox } from '../../agents/inbox/process.ts';
import type { Claude } from '@scottmroth5/agent-core';
import type { JobStore } from '../../tools/types.ts';
import type { InboxServices } from '../inbox-routes.ts';
import type { Jobs } from '../jobs.ts';

export function defineInboxTasks({ store, jobs, claude, inbox }: { store: JobStore; jobs: Jobs; claude: Claude | null; inbox: InboxServices }) {
  // The check writes its own traced run (named inbox, which the alerts and the schedule's catch-up read).
  jobs.define('inbox', async (_payload, { step, logger }) => {
    if (!inbox.ready()) throw new Error('Gmail is not signed in. Run "npm run inbox:auth" first.');
    const gmail = inbox.gmail({ onWait: (ms) => logger.warn(`Gmail rate limit reached; waiting ${ms / 1000} seconds, then continuing.`) });
    // A tracer per task, so the run's log lines also go to the task's output (the Activity tab).
    const run = await createJobTracer({ store, logger }).startRun('inbox', { model: inbox.cfg.model });
    try {
      step('Reading new mail');
      // claude is set wherever Gmail can be ready (the demo has neither, and ready() refused above).
      const s = await runInbox({ store, gmail, claude: claude as Claude, cfg: inbox.cfg, key: inbox.key(), run, log: run.log });
      for (const n of s.notices) logger.info(n);
      await run.finish(s.failures.length ? 'partial' : 'ok', { ...s, notices: s.notices.length });
      step(`Done: ${s.considered} job emails, ${s.matched} linked, ${s.needsReview} to review`);
      return { considered: s.considered, matched: s.matched, needsReview: s.needsReview, opportunities: s.opportunities, statusChanges: s.statusChanges.length, notices: s.notices, failures: s.failures.length };
    } catch (err) {
      await run.finish('failed', { error: (err as Error).message });
      throw err;
    }
  }, { trace: false });
}

/**
 * Starts an inbox check as a task. One at a time per user (the inbox task type, and onlyOne for a button press; a
 * scheduled check while one waits or runs follows that one). A check started while the user's pipeline waits or runs
 * waits for it to finish (depends_on), as the scheduled run did. ready says whether Gmail is set up; a scheduler in a
 * process of its own holds no Gmail settings and passes () => true, leaving the check to the worker that runs it.
 */
export function inboxStarter({ store, jobs, ready }: { store: JobStore; jobs: Jobs; ready: () => boolean }) {
  const { db } = store;
  return async function startCheck({ by = 'button' }: { by?: string } = {}) {
    if (!ready()) throw Object.assign(new Error('Gmail is not signed in. Run "npm run inbox:auth" first.'), { statusCode: 400 });
    const uid = currentUserId() ?? OWNER_ID;
    if (by === 'schedule') {
      const mine = await jobs.queue.active(uid, 'inbox');
      if (mine) return mine.id;
    }
    const pipeline = await jobs.queue.active(uid, 'pipeline');
    // Runs outside the queue (npm run inbox or npm run pipeline on this machine) show only in the runs table.
    for (const name of pipeline ? ['inbox', 'inbox-backfill'] : ['inbox', 'inbox-backfill', 'pipeline']) {
      try {
        await assertNoRunningRun(db, name);
      } catch (err) {
        throw Object.assign(new Error(`${(err as Error).message} Try again when it finishes.`), { statusCode: 409 });
      }
    }
    const r = await jobs.queue.enqueue('inbox', { by }, {
      userId: uid,
      interactive: by !== 'schedule',
      requestedBy: by === 'schedule' ? 'schedule' : 'user',
      dependsOn: pipeline?.id ?? null,
      onlyOne: 'An inbox check is already running. Try again when it finishes.',
    });
    return r.id;
  };
}

export type StartCheck = ReturnType<typeof inboxStarter>;
