// A worker process (v3 Phase 7, apps/worker.ts): the task handlers (server/tasks) and the queue's loops for the pools it
// serves, its row in the workers table, and a health check. The API only enqueues; this is where the work runs. A
// process that runs the browser pool alone needs no Claude key, and one without the browser pool no Chromium.
import { createRuntime } from './runtime.ts';
import { defineTasks } from './tasks/index.ts';
import { graceMs, workerService } from './roles.ts';
import { serveHealth } from '../tools/health.ts';
import type { JobStore } from '../db/index.ts';
import type { UserConfig } from '../agents/user-config.ts';
import type { AppServices } from './app.ts';
import type { Pool } from '../tools/queue/queue.ts';

export async function runWorker({ store, config, services, pools, version = null, healthPort = null }: {
  store: JobStore;
  config: UserConfig;
  services: AppServices;
  pools: Pool[];
  version?: string | null;
  /** The health check's port on 127.0.0.1; null for none (tests), 0 for any free one. */
  healthPort?: number | null;
}) {
  const service = workerService(pools);
  const runtime = createRuntime({ store, config, services });
  defineTasks(runtime);
  const workers = runtime.jobs.run({ pools, service, version });
  await workers.started; // so the health check never answers before the worker's first heartbeat
  const health = healthPort == null ? null : await serveHealth({ port: healthPort, service, check: () => workers.healthy() });
  return {
    service,
    jobs: runtime.jobs,
    health,
    /** Stops taking tasks; running ones get the grace period, then are requeued or failed visibly. */
    async stop(grace = graceMs(service)) {
      await runtime.jobs.stop(grace);
      await health?.close();
    },
  };
}
