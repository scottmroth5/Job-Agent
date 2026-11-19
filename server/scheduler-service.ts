// The scheduler as a process of its own (v3 Phase 7, apps/scheduler.ts): each user's automatic runs and the app's
// scheduled jobs (server/automatic-runs.ts), and a health check. It only enqueues tasks and reads the database, so it
// holds the database login and nothing else: alerts go out as notify tasks, and whether Gmail is set up is for the io
// worker that runs the check to say (a check without it fails visibly, and alerts the owner).
import { createJobs } from './jobs.ts';
import { pipelineStarter } from './tasks/pipeline.ts';
import { inboxStarter } from './tasks/inbox.ts';
import { queuedAlerts } from './tasks/notify.ts';
import { createAutomaticRuns } from './automatic-runs.ts';
import { serveHealth } from '../tools/health.ts';
import type { JobStore } from '../db/index.ts';
import type { Schedule } from '../tools/scheduler.ts';

export async function runScheduler({ store, schedules, appUrl = () => '', healthPort = null, log = console, timings = {} }: {
  store: JobStore;
  /** The .env schedules (server/services.ts appSchedules). */
  schedules: Array<{ name: string; schedule: Schedule }>;
  appUrl?: () => string;
  healthPort?: number | null;
  log?: { info?: (text: string) => void; warn?: (text: string) => void };
  /** Tests only: how often a run checks its task, everyone resyncs, and a saved change is looked for. */
  timings?: { waitMs?: number; syncMs?: number; changeMs?: number };
}) {
  const jobs = createJobs({ store, ownerConfig: null, log });
  const ready = () => true;
  const startCheck = inboxStarter({ store, jobs, ready });
  const runs = createAutomaticRuns({
    store,
    jobs,
    schedules,
    starters: {
      pipeline: pipelineStarter({ store, jobs }),
      inbox: { start: startCheck, ready },
      app: { backup: () => jobs.start('backup', { by: 'schedule' }, { by: 'schedule' }), 'restore-test': () => jobs.start('restore-test', { by: 'schedule' }, { by: 'schedule' }) },
    },
    alerts: queuedAlerts({ db: store.admin, jobs, appUrl, log }),
    log,
    ...timings,
  });
  await runs.start();
  const health = healthPort == null ? null : await serveHealth({ port: healthPort, service: 'scheduler', check: () => runs.healthy() });
  return {
    runs,
    jobs,
    health,
    async stop() {
      runs.stop();
      await health?.close();
    },
  };
}
