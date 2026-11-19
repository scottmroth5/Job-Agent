// The process roles (v3 Phase 7). The one-process app (npm run ui, server/main.ts, and the demo) runs every role; in the
// cloud each is a service of its own sharing the database:
//   api        routes, short AI calls, account emails (apps/api.ts)
//   scheduler  each user's automatic runs; it only enqueues (apps/scheduler.ts)
//   worker     the task pools named in POOLS: browser, ai, io, or several joined by commas (apps/worker.ts)
// On a stop (docker stop's SIGTERM on a deploy) a process stops taking work and gives what it is running a grace
// period: long enough for most of that pool's tasks, short of compose's stop_grace_period. SHUTDOWN_GRACE_SECONDS
// overrides it.
import { POOLS, type Pool } from '../tools/queue/queue.ts';

/** Seconds a stopping process waits for running tasks, by service; a worker waits for its slowest pool. */
export const GRACE_SECONDS: Record<string, number> = { all: 10, api: 30, scheduler: 10, ai: 300, browser: 120, io: 120 };

/** The pools POOLS names (all of them when unset); throws on a name that is not a pool, so a typo never idles a worker. */
export function poolsFrom(value: string | undefined): Pool[] {
  if (!value?.trim()) return [...POOLS];
  const names = value.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (const n of names) if (!(POOLS as readonly string[]).includes(n)) throw new Error(`POOLS: "${n}" is not a pool (${POOLS.join(', ')}).`);
  return POOLS.filter((p) => names.includes(p));
}

/** A worker service's name, from its pools: worker-ai, worker-browser, worker-io, or worker-ai-io for several. */
export const workerService = (pools: readonly Pool[]) => `worker-${pools.join('-')}`;

/** The grace period in ms for a service ("all", "api", "scheduler", or a worker-<pools> name). */
export function graceMs(service: string, env: NodeJS.ProcessEnv = process.env) {
  const set = Number(env.SHUTDOWN_GRACE_SECONDS);
  if (env.SHUTDOWN_GRACE_SECONDS?.trim() && Number.isFinite(set) && set >= 0) return set * 1000;
  const parts = service.startsWith('worker-') ? service.slice('worker-'.length).split('-') : [service];
  return Math.max(...parts.map((p) => GRACE_SECONDS[p] ?? GRACE_SECONDS.all)) * 1000;
}
