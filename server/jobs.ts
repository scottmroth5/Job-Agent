// The app's tasks on the durable queue (v3 Phase 6, PR 2; tools/queue/queue.ts, decision 0008). Each kind of work is a
// handler defined once (define), next to the route that starts it; a route only enqueues (start). The handler gets the
// stored request (the payload) and rebuilds its work from it, so a task waiting when the server restarts still runs.
//
// Every handler runs as its task's user, in their time zone, with their settings loaded (withUserConfig), as a request
// does; with a traced run (createJobTracer, the cost) unless it records its own (the pipeline and inbox scripts); with a
// browser when it asks for one. An AI task checks the user's Claude budget before it starts, so a capped user's task
// fails before anything is spent. brief() is the task as /api/tasks has always shown it: a task still waiting reports
// status running with waiting: true, so every screen that follows a task keeps working.
import { createJobTracer } from '../tools/trace.ts';
import { runAsUser, currentUserId } from '../db/scope.ts';
import { OWNER_ID } from '../db/users.ts';
import { withUserConfig } from '../agents/user-config.ts';
import { checkBudget } from '../agents/budget.ts';
import { createQueue, type Handler, type HandlerContext, type Job, type Logger, type Queue } from '../tools/queue/queue.ts';
import type { JobSearchConfig } from '../tools/config.ts';
import type { JobStore } from '../tools/types.ts';
import type { PageRenderer } from '../agents/discovery/types.ts';

type Run = Awaited<ReturnType<ReturnType<typeof createJobTracer>['startRun']>>;

export interface TaskContext {
  job: Job;
  step: HandlerContext['step'];
  logger: Logger;
  signal: AbortSignal;
  /** The task's traced run (null for a handler defined with trace: false, which records its own). */
  run: Run | null;
  /** Links the task to a run it opened itself (trace: false), for cost totals and the sweep. */
  setRunId: HandlerContext['setRunId'];
  browser: PageRenderer | null;
}
export type TaskHandler<P> = (payload: P, ctx: TaskContext) => Promise<unknown>;

export interface DefineOptions {
  /** Open a traced run named ui-<type> around the handler (default true). */
  trace?: boolean;
  /** Give the handler a browser (createBrowser), closed afterwards. */
  browser?: boolean;
}

/** Keys of a payload that /api/tasks shows as meta (the Activity tab's "job #"); never the request's text. */
const META_KEYS = ['id', 'url', 'by'];

export function createJobs({ store, ownerConfig, createBrowser = null, log = console, queueOptions = {} }: {
  store: JobStore;
  /** The owner's settings file (server/app.ts ownerConfig): handlers load each user's settings like a request does. */
  ownerConfig: JobSearchConfig | null;
  createBrowser?: (() => Promise<PageRenderer | null>) | null;
  log?: { info?: (text: string) => void; warn?: (text: string) => void };
  queueOptions?: Partial<Parameters<typeof createQueue>[0]>;
}) {
  const queue: Queue = createQueue({ db: store.admin, log, ...queueOptions });
  const handlers: Record<string, Handler> = {};

  /** Runs fn as the user, in their time zone, with their settings, as a request would (server/app.ts preHandler). */
  const asUser = async <T>(uid: number, fn: () => Promise<T>): Promise<T> => {
    const timeZone = ((await store.admin.prepare('SELECT time_zone FROM users WHERE id = ?').pluck().get(uid)) as string | null | undefined) ?? null;
    return await runAsUser(uid, async () => (ownerConfig ? await withUserConfig(store.admin, uid, ownerConfig, fn) : await fn()), { timeZone });
  };

  function define<P>(type: string, handler: TaskHandler<P>, { trace = true, browser = false }: DefineOptions = {}) {
    handlers[type] = async (ctx) =>
      asUser(ctx.job.userId, async () => {
        if (ctx.job.pool === 'ai') await checkBudget(store.db, { uid: ctx.job.userId });
        const run = trace ? await createJobTracer({ store, logger: ctx.logger }).startRun(`ui-${type}`, metaOf(ctx.job.payload)) : null;
        if (run?.id) await ctx.setRunId(Number(run.id));
        const b = browser && createBrowser ? ((await createBrowser()) as (PageRenderer & { close?: () => Promise<unknown> }) | null) : null;
        try {
          const result = await handler(ctx.job.payload as P, { job: ctx.job, step: ctx.step, logger: ctx.logger, signal: ctx.signal, run, setRunId: ctx.setRunId, browser: b });
          await run?.finish('ok', result && typeof result === 'object' ? { ...result, materials: undefined } : null);
          return result;
        } catch (err) {
          await run?.finish('failed', { error: (err as Error).message });
          throw err;
        } finally {
          await b?.close?.();
        }
      });
  }

  /**
   * Starts a task for the current user (the request's, or the owner for a scheduled run outside one): a user's own
   * request goes in the interactive band; by 'schedule' is scheduled work. onlyOne refuses (409, that message) while
   * the user already has one of this type waiting or running; dependsOn waits for that task to finish. Returns the task id.
   */
  async function start(
    type: string,
    payload: unknown,
    { by = 'user', userId = currentUserId() ?? OWNER_ID, onlyOne = null, dependsOn = null }: { by?: 'user' | 'schedule'; userId?: number; onlyOne?: string | null; dependsOn?: string | null } = {},
  ) {
    const r = await queue.enqueue(type, payload, { userId, interactive: by === 'user', requestedBy: by, onlyOne, dependsOn });
    return r.id;
  }

  /** The task as /api/tasks shows it (without its lines). */
  async function brief(job: Job, uid: number) {
    const waiting = job.status === 'queued';
    const status = waiting || job.status === 'running' ? 'running' : job.status === 'done' ? 'done' : 'failed';
    const error = job.error ?? (job.status === 'skipped' ? 'Skipped: this kind of task is turned off.' : job.status === 'cancelled' ? 'Cancelled.' : null);
    return {
      id: job.id,
      kind: job.type,
      meta: metaOf(job.payload),
      status,
      waiting,
      steps: await queue.steps(job.id, uid),
      result: job.result,
      error: status === 'failed' ? error : null,
      startedAt: job.startedAt ?? job.createdAt,
      finishedAt: job.finishedAt,
      lines: await queue.lineCount(job.id, uid),
    };
  }

  /** Waits for a task to finish (the scheduler, and tests), as whichever user owns it. */
  async function wait(id: string, timeoutMs = 10_000) {
    const uid = await queue.ownerOf(id);
    if (uid == null) return null;
    const job = await queue.wait(id, uid, timeoutMs);
    return job ? brief(job, uid) : null;
  }

  let workers: { stop: (waitMs?: number) => Promise<void> } | null = null;
  return {
    queue,
    define,
    start,
    brief,
    wait,
    /** Starts this process's workers for every defined type. */
    run() {
      workers ??= queue.start(handlers);
    },
    async stop() {
      await workers?.stop();
      workers = null;
    },
  };
}

function metaOf(payload: unknown) {
  if (!payload || typeof payload !== 'object') return {};
  return Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([k]) => META_KEYS.includes(k)));
}

export type Jobs = ReturnType<typeof createJobs>;
