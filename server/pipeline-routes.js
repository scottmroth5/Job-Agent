// Run the pipeline from the UI. It runs as its own process (the same scripts/pipeline.js as npm run pipeline),
// so a long run never blocks the server, and its step lines become task progress.
import { assertNoRunningRun } from '../tools/runs.js';

const anyObject = { type: 'object', additionalProperties: true };
const LOCKS = ['pipeline', 'inbox', 'discover', 'score', 'hunt'];

/** The latest pipeline run, and whether one is in progress (from the runs table, so it survives a page reload). */
export function pipelineState(db) {
  const last = db.prepare("SELECT status, started_at AS startedAt, finished_at AS finishedAt FROM runs WHERE name = 'pipeline' ORDER BY id DESC LIMIT 1").get() ?? null;
  let running = false;
  try {
    assertNoRunningRun(db, 'pipeline');
  } catch {
    running = true;
  }
  const lastFinished = db
    .prepare("SELECT status, started_at AS startedAt, finished_at AS finishedAt FROM runs WHERE name = 'pipeline' AND status != 'running' ORDER BY id DESC LIMIT 1")
    .get() ?? null;
  return { running, last, lastFinished };
}

/** Turns the pipeline's console lines into short progress messages. */
export function progressLine(line) {
  const step = /^\[pipeline\] (Step \d+\/\d+: \w+)/.exec(line);
  if (step) return step[1];
  if (/^Sent "/.test(line)) return 'Report emailed';
  if (/^\[pipeline\] Inbox skipped/.test(line)) return 'Inbox skipped';
  return null;
}

/**
 * @param {object} ctx
 * @param {(opts: { onLine: (line: string) => void }) => Promise<{ code: number, lastError: string | null }>} ctx.runPipeline
 */
export function registerPipelineRoutes(app, { db, tasks, runPipeline }) {
  let taskId = null;

  app.get('/api/pipeline', { schema: { summary: 'Last pipeline run and whether one is running', response: { 200: anyObject } } }, async () => {
    const task = taskId ? tasks.get(taskId) : null;
    return { ...pipelineState(db), taskId: task?.status === 'running' ? taskId : null };
  });

  app.post(
    '/api/pipeline/run',
    { schema: { summary: 'Run the pipeline now (discover, score, write materials, archive, email the report)', response: { 202: { type: 'object', properties: { taskId: { type: 'string' } } } } } },
    async (req, reply) => {
      if (taskId && tasks.get(taskId)?.status === 'running') throw Object.assign(new Error('The pipeline is already running.'), { statusCode: 409 });
      for (const name of LOCKS) {
        try {
          assertNoRunningRun(db, name);
        } catch (err) {
          throw Object.assign(new Error(`${err.message} Try again when it finishes.`), { statusCode: 409 });
        }
      }
      taskId = tasks.start('pipeline', {}, async (step) => {
        step('Starting');
        const { code, lastError } = await runPipeline({ onLine: (line) => {
          const p = progressLine(line);
          if (p) step(p);
        } });
        if (code !== 0) throw new Error(lastError ? `The pipeline stopped: ${lastError}` : `The pipeline stopped with exit code ${code}.`);
        return { ...pipelineState(db).lastFinished };
      });
      return reply.code(202).send({ taskId });
    },
  );
}
