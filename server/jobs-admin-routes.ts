// Admin > Jobs (v3 Phase 6, PR 4): the background task queue, app-wide, for admins only and never in the demo
// (ADMIN_ONLY in server/app.ts). Shows each pool's load, the task types and their history, dead letters, and totals
// by type; edits task types and pool limits, and retries or discards a dead letter. Everything goes through the queue
// (tools/queue/queue.ts), the only code that touches its tables. A dead letter shows its kind, account, and error,
// never what was asked or the task's output.
import type { Queue } from '../tools/queue/queue.ts';
import type { App } from './types.ts';

const anyObject = { type: 'object', additionalProperties: true };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } };

export function registerJobsAdminRoutes(app: App, { queue }: { queue: Queue }) {
  app.get<{ Querystring: { days?: number } }>(
    '/api/admin/jobs',
    {
      schema: {
        summary: 'The task queue: pools, the worker processes online, task types, recent changes, dead letters, and totals by type (admin)',
        querystring: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90 } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const days = req.query.days ?? 30;
      const [pools, workers, types, history, dead, totals] = await Promise.all([queue.overview(), queue.workers(), queue.types(), queue.typeHistory(), queue.deadLetters(), queue.totals(days)]);
      return { pools, workers, types, history, dead, totals, days };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { priority?: number; enabled?: boolean; oneAtATime?: 'none' | 'user' | 'app'; retryLimit?: number; timeoutSeconds?: number; agingMinutes?: number | null; applyToWaiting?: boolean };
  }>(
    '/api/admin/jobs/types/:id',
    {
      schema: {
        summary: "Change a task type's priority, on or off, one at a time, retries, time limit, or aging (admin)",
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            priority: { type: 'integer' },
            enabled: { type: 'boolean' },
            oneAtATime: { type: 'string', enum: ['none', 'user', 'app'] },
            retryLimit: { type: 'integer' },
            timeoutSeconds: { type: 'integer' },
            agingMinutes: { type: ['integer', 'null'] },
            applyToWaiting: { type: 'boolean' },
          },
        },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const { applyToWaiting, ...patch } = req.body;
      return queue.updateType(req.params.id, patch, { by: req.uid ?? null, applyToWaiting });
    },
  );

  app.put<{ Params: { pool: string }; Body: { concurrency: number; perUser: number; reserved: number } }>(
    '/api/admin/jobs/pools/:pool',
    {
      schema: {
        summary: "Change a pool's workers, per-user limit, and workers reserved for tasks people start (admin)",
        params: { type: 'object', required: ['pool'], properties: { pool: { type: 'string', enum: ['browser', 'ai', 'io'] } } },
        body: {
          type: 'object',
          required: ['concurrency', 'perUser', 'reserved'],
          additionalProperties: false,
          properties: { concurrency: { type: 'integer' }, perUser: { type: 'integer' }, reserved: { type: 'integer' } },
        },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      await queue.updatePool(req.params.pool, req.body, { by: req.uid ?? null });
      return { saved: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/jobs/tasks/:id/retry',
    { schema: { summary: 'Run a dead task again (admin)', params: idParams, response: { 200: anyObject } } },
    async (req) => {
      if (!(await queue.retry(req.params.id))) throw Object.assign(new Error('That task is not waiting for a retry.'), { statusCode: 404 });
      return { retried: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/jobs/tasks/:id/discard',
    { schema: { summary: 'Discard a dead task (admin)', params: idParams, response: { 200: anyObject } } },
    async (req) => {
      if (!(await queue.discard(req.params.id))) throw Object.assign(new Error('That task is not waiting for a retry.'), { statusCode: 404 });
      return { discarded: true };
    },
  );
}
