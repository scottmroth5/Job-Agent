// Run the pipeline from the UI. It runs as its own process (the same scripts/pipeline.js as npm run pipeline),
// so a long run never blocks the server, and its step lines become task progress. Each user runs their own pipeline
// (scripts/pipeline.js --user=<id>); one runs at a time across the app, since they share the browser and the sources.
import { assertNoRunningRun, oneStartAtATime } from '../tools/runs.ts';
import { currentUserId } from '../db/scope.ts';
import { OWNER_ID } from '../db/users.ts';
import type { Db } from '../tools/types.ts';
import type { App, Tasks } from './types.ts';

/** Runs scripts/pipeline.js for a user (args: --no-score, --no-letters): onLine gets each stdout line, onError each stderr line. */
export type RunPipeline = (opts: { user: number; args?: string[]; onLine: (line: string) => void; onError: (line: string) => void }) => Promise<{ code: number; lastError: string | null }>;
/** A user's automatic pipeline runs for the UI: whether they are on, and the next one (ISO) and its schedule. */
export type PipelineSchedule = (uid: number) => { automatic: boolean; next: string | null; schedule: string | null };

const anyObject = { type: 'object', additionalProperties: true };
const LOCKS = ['pipeline', 'inbox', 'discover', 'score', 'hunt'];

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
  { db, tasks, runPipeline, schedule = () => ({ automatic: false, next: null, schedule: null }) }: { db: Db; tasks: Tasks; runPipeline: RunPipeline; schedule?: PipelineSchedule },
) {
  let taskId: string | null = null;

  /**
   * Starts the current user's pipeline as a task (the button and the scheduler); throws 409 when one is already running.
   * args leaves out steps (a scheduled run's automatic runs setting); the button runs every step.
   */
  const start = ({ by = 'button', args = [] }: { by?: string; args?: string[] } = {}) => oneStartAtATime(async () => {
    const uid = currentUserId() ?? OWNER_ID;
    if (taskId && tasks.get(taskId)?.status === 'running') throw Object.assign(new Error('The pipeline is already running.'), { statusCode: 409 });
    for (const name of LOCKS) {
      try {
        await assertNoRunningRun(db, name);
      } catch (err) {
        throw Object.assign(new Error(`${(err as Error).message} Try again when it finishes.`), { statusCode: 409 });
      }
    }
    taskId = tasks.start('pipeline', { by }, async (step: (message: string, opts?: { log?: boolean }) => void, { logger }: { logger: { info: (t: string) => void; error: (t: string) => void } }) => {
      step(by === 'schedule' ? 'Starting (scheduled)' : 'Starting');
      const { code, lastError } = await runPipeline({
        user: uid,
        args,
        onLine: (line: string) => {
          logger.info(line);
          const p = progressLine(line);
          if (p) step(p, { log: false });
        },
        onError: (line: string) => logger.error(line),
      });
      if (code !== 0) throw new Error(lastError ? `The pipeline stopped: ${lastError}` : `The pipeline stopped with exit code ${code}.`);
      return { ...(await pipelineState(db, uid)).lastFinished };
    });
    return taskId;
  });

  app.get('/api/pipeline', { schema: { summary: 'Your last pipeline run, whether one is running, and the next scheduled run', response: { 200: anyObject } } }, async (req) => {
    const uid = req.uid ?? OWNER_ID;
    // The running task is shown only to its own user; others just see that one is running.
    const task = taskId ? tasks.get(taskId, { uid }) : null;
    const mine = schedule(uid);
    return { ...(await pipelineState(db, uid)), taskId: task?.status === 'running' ? taskId : null, automatic: mine.automatic, nextScheduled: mine.next, schedule: mine.schedule };
  });

  app.post(
    '/api/pipeline/run',
    { schema: { summary: 'Run your pipeline now (discover, score, write materials, archive; the owner also gets the report email)', response: { 202: { type: 'object', properties: { taskId: { type: 'string' } } } } } },
    async (req, reply) => reply.code(202).send({ taskId: await start() }),
  );

  return { start };
}
