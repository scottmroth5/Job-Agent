// Run the pipeline from the UI. Each step (discover, score, hunt, archive, report) is a task of its own on the queue,
// in the pool its work needs, and runs as its own process (scripts/pipeline.js --only=<step>), so a long run never
// blocks the server. The pipeline task queues its steps, each waiting for the one before (depends_on; a failed step
// does not stop the next, as in npm run pipeline), records the pipeline's run, and copies the steps' output into its
// own, so its step lines become the pipeline's progress. Each user runs their own pipeline
// (scripts/pipeline.js --user=<id>); one runs at a time across the app, since they share the browser and the sources:
// the pipeline task type is one at a time across the app (tools/queue), so a second user's pipeline waits its turn.
import { assertNoRunningRun } from '../tools/runs.ts';
import { currentUserId } from '../db/scope.ts';
import { OWNER_ID } from '../db/users.ts';
import { createJobTracer } from '../tools/trace.ts';
import { FINISHED } from '../tools/queue/queue.ts';
import type { Db, JobStore } from '../tools/types.ts';
import type { App } from './types.ts';
import type { Jobs } from './jobs.ts';

/** Runs scripts/pipeline.js for a user (args: --no-score, --no-letters): onLine gets each stdout line, onError each stderr line. */
export type RunPipeline = (opts: { user: number; args?: string[]; onLine: (line: string) => void; onError: (line: string) => void }) => Promise<{ code: number; lastError: string | null }>;
/** A user's automatic pipeline runs for the UI: whether they are on, and the next one (ISO) and its schedule. */
export type PipelineSchedule = (uid: number) => { automatic: boolean; next: string | null; schedule: string | null };

const anyObject = { type: 'object', additionalProperties: true };
const LOCKS = ['pipeline', 'inbox', 'discover', 'score', 'hunt'];
/** The pipeline's steps in order, each a task type pipeline-<step>. */
export const PIPELINE_STEPS = ['discover', 'score', 'hunt', 'archive', 'report'] as const;
/** The step an automatic runs setting leaves out (scripts/pipeline.js flags). */
const SKIPPED_BY: Record<string, string> = { score: '--no-score', hunt: '--no-letters' };

// A user's runs; the owner's include runs from before runs had a user.
const MINE = '(user_id = ? OR (? = 1 AND user_id IS NULL))';

/**
 * A user's latest pipeline run, and whether any pipeline is in progress (from the runs table, so it survives a page
 * reload).
 */
export async function pipelineState(db: Db, uid: number = OWNER_ID) {
  const last = await db.prepare(`SELECT status, started_at AS "startedAt", finished_at AS "finishedAt" FROM runs WHERE name = 'pipeline' AND ${MINE} ORDER BY id DESC LIMIT 1`).get(uid, uid) ?? null;
  let running = false;
  try {
    await assertNoRunningRun(db, 'pipeline');
  } catch {
    running = true;
  }
  const lastFinished = await db
    .prepare(`SELECT status, started_at AS "startedAt", finished_at AS "finishedAt" FROM runs WHERE name = 'pipeline' AND status != 'running' AND ${MINE} ORDER BY id DESC LIMIT 1`)
    .get(uid, uid) ?? null;
  return { running, last, lastFinished };
}

/** Turns the pipeline's console lines into short progress messages. */
export function progressLine(line: string) {
  const step = /^\[pipeline\] (Step \d+\/\d+: \w+(?: skipped)?)/.exec(line); // skipped: left out by the automatic runs setting
  if (step) return step[1];
  if (/^Sent "/.test(line)) return 'Report emailed';
  if (/^\[pipeline\] Inbox skipped/.test(line)) return 'Inbox skipped';
  return null;
}

/** schedule(uid) is that user's automatic runs (server/app.ts), or none when there is no scheduler. */
export function registerPipelineRoutes(
  app: App,
  {
    store,
    jobs,
    runPipeline,
    schedule = () => ({ automatic: false, next: null, schedule: null }),
    followMs = 250,
  }: { store: JobStore; jobs: Jobs; runPipeline: RunPipeline; schedule?: PipelineSchedule; followMs?: number },
) {
  const { db } = store;

  // Each step: the script with --only, as the task's user. Its own process records the step's run.
  for (const name of PIPELINE_STEPS) {
    jobs.define<{ since: string }>(`pipeline-${name}`, async ({ since }, { job, step, logger }) => {
      const { code, lastError } = await runPipeline({
        user: job.userId,
        args: [`--only=${name}`, `--since=${since}`],
        onLine: (line: string) => {
          logger.info(line);
          const p = progressLine(line);
          if (p) step(p, { log: false });
        },
        onError: (line: string) => logger.error(line),
      });
      if (code !== 0) throw new Error(lastError ?? `The ${name} step stopped with exit code ${code}.`);
    }, { trace: false });
  }

  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });

  // The pipeline: queues its steps, follows them, and records the pipeline's run (the button, the schedule's catch-up,
  // the alerts, and the last run read it). Its steps keep running if it stops (a restart); the sweep fails it visibly.
  jobs.define<{ by: string; args?: string[] }>('pipeline', async ({ by, args = [] }, { job, step, logger, signal, setRunId }) => {
    const uid = job.userId;
    step(by === 'schedule' ? 'Starting (scheduled)' : 'Starting');
    const run = await createJobTracer({ store, logger }).startRun('pipeline');
    if (run.id) await setRunId(Number(run.id));
    let finished = false;
    try {
      const since = new Date().toISOString();
      const children: Array<{ name: string; id: string }> = [];
      let before: string | null = null;
      for (const [i, name] of PIPELINE_STEPS.entries()) {
        if (SKIPPED_BY[name] && args.includes(SKIPPED_BY[name])) {
          const line = `[pipeline] Step ${i + 1}/${PIPELINE_STEPS.length}: ${name} skipped (automatic runs setting)`;
          logger.info(line);
          step(progressLine(line) as string, { log: false });
          run.log('info', `${name} skipped by the automatic runs setting`);
          continue;
        }
        const r = await jobs.queue.enqueue(`pipeline-${name}`, { since }, {
          userId: uid,
          interactive: job.interactive,
          requestedBy: job.requestedBy,
          dependsOn: before,
          parentId: job.id,
        });
        if (r.status === 'skipped') logger.warn(`The ${name} step is turned off in Admin > Jobs; skipped.`);
        children.push({ name, id: r.id });
        before = r.id;
      }

      // Follow each step in turn: its output becomes the pipeline's, its step lines the pipeline's progress.
      const failed: Array<{ name: string; error: string }> = [];
      for (const child of children) {
        let from = 0;
        for (;;) {
          const t = await jobs.queue.get(child.id, uid);
          const out = await jobs.queue.lines(child.id, uid, from);
          from = out.next;
          for (const l of out.lines) {
            if (l.level === 'warn') logger.warn(l.text);
            else if (l.level === 'error') logger.error(l.text);
            else logger.info(l.text);
            const p = progressLine(l.text);
            if (p) step(p, { log: false });
          }
          if (!t || FINISHED.includes(t.status)) {
            if (t && (t.status === 'failed' || t.status === 'dead')) failed.push({ name: child.name, error: t.error ?? 'failed' });
            break;
          }
          if (signal.aborted) throw signal.reason as Error;
          await pause(followMs, signal);
        }
      }

      const report = failed.find((f) => f.name === 'report');
      await run.finish(report ? 'failed' : failed.length ? 'partial' : 'ok', { steps: children.length, failed: failed.map((f) => f.name) });
      finished = true;
      // As before the split: a failed step is in the report and the next steps still ran; only a report that could
      // not go out fails the pipeline.
      if (report) throw new Error(`The pipeline stopped: ${report.error}`);
      return { ...(await pipelineState(db, uid)).lastFinished };
    } catch (err) {
      if (!finished) await run.finish('failed', { error: (err as Error).message });
      throw err;
    }
  }, { trace: false });

  /**
   * Starts the current user's pipeline as a task (the button and the scheduler); throws 409 when one is already running.
   * args leaves out steps (a scheduled run's automatic runs setting); the button runs every step.
   */
  const start = async ({ by = 'button', args = [] }: { by?: string; args?: string[] } = {}) => {
    const uid = currentUserId() ?? OWNER_ID;
    // A scheduled run while this user's pipeline is already waiting or running follows that one instead.
    if (by === 'schedule') {
      const mine = await jobs.queue.active(uid, 'pipeline');
      if (mine) return mine.id;
    }
    // A pipeline started while the user's inbox check waits or runs waits for it (depends_on), as before it was refused.
    const inbox = await jobs.queue.active(uid, 'inbox');
    // A pipeline run outside the queue (npm run pipeline, or one of its steps, on this machine) shows only in the runs
    // table. While a queued pipeline runs, its rows are its own and the queue orders the rest.
    if (!(await jobs.queue.anyActive('pipeline'))) {
      for (const name of LOCKS.filter((n) => !(inbox && n === 'inbox'))) {
        try {
          await assertNoRunningRun(db, name);
        } catch (err) {
          throw Object.assign(new Error(`${(err as Error).message} Try again when it finishes.`), { statusCode: 409 });
        }
      }
    }
    return jobs.start('pipeline', { by, args }, { by: by === 'schedule' ? 'schedule' : 'user', userId: uid, onlyOne: 'The pipeline is already running.', dependsOn: inbox?.id ?? null });
  };

  app.get('/api/pipeline', { schema: { summary: 'Your last pipeline run, whether one is running, and the next scheduled run', response: { 200: anyObject } } }, async (req) => {
    const uid = req.uid ?? OWNER_ID;
    // The user's own waiting or running task; others just see that one is running.
    const task = await jobs.queue.active(uid, 'pipeline');
    const mine = schedule(uid);
    const state = await pipelineState(db, uid);
    return { ...state, running: state.running || (await jobs.queue.anyActive('pipeline')), taskId: task?.id ?? null, automatic: mine.automatic, nextScheduled: mine.next, schedule: mine.schedule };
  });

  app.post(
    '/api/pipeline/run',
    { schema: { summary: 'Run your pipeline now (discover, score, write materials, archive; the owner also gets the report email)', response: { 202: { type: 'object', properties: { taskId: { type: 'string' } } } } } },
    async (req, reply) => reply.code(202).send({ taskId: await start() }),
  );

  return { start };
}
