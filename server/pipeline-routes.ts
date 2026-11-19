// Run the pipeline from the UI. The pipeline and its steps are tasks (server/tasks/pipeline.ts); these routes only show
// its state and start one, through the same starter the scheduler uses.
import { OWNER_ID } from '../db/users.ts';
import { pipelineState, type StartPipeline } from './tasks/pipeline.ts';
import type { JobStore } from '../tools/types.ts';
import type { App } from './types.ts';
import type { Jobs } from './jobs.ts';

/** A user's automatic pipeline runs for the UI: whether they are on, and the next one (ISO) and its schedule. */
export type PipelineSchedule = (uid: number) => Promise<{ automatic: boolean; next: string | null; schedule: string | null }>;

const anyObject = { type: 'object', additionalProperties: true };

/** schedule(uid) is that user's automatic runs (server/automatic-runs.ts), or none when there is no scheduler. */
export function registerPipelineRoutes(
  app: App,
  {
    store,
    jobs,
    start,
    schedule = async () => ({ automatic: false, next: null, schedule: null }),
  }: { store: JobStore; jobs: Jobs; start: StartPipeline; schedule?: PipelineSchedule },
) {
  const { db } = store;

  app.get('/api/pipeline', { schema: { summary: 'Your last pipeline run, whether one is running, and the next scheduled run', response: { 200: anyObject } } }, async (req) => {
    const uid = req.uid ?? OWNER_ID;
    // The user's own waiting or running task; others just see that one is running.
    const task = await jobs.queue.active(uid, 'pipeline');
    const mine = await schedule(uid);
    const state = await pipelineState(db, uid);
    return { ...state, running: state.running || (await jobs.queue.anyActive('pipeline')), taskId: task?.id ?? null, automatic: mine.automatic, nextScheduled: mine.next, schedule: mine.schedule };
  });

  app.post(
    '/api/pipeline/run',
    { schema: { summary: 'Run your pipeline now (discover, score, write materials, archive; the owner also gets the report email)', response: { 202: { type: 'object', properties: { taskId: { type: 'string' } } } } } },
    async (req, reply) => reply.code(202).send({ taskId: await start() }),
  );
}
