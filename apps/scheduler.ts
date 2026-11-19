// The scheduler service (v3 Phase 7): each user's automatic runs and the app's scheduled jobs, enqueued for the workers.
// It needs only the database login. HEALTH_PORT (default 5181) answers GET /healthz on 127.0.0.1.
import { openJobStore } from '../db/index.ts';
import { appSchedules } from '../server/services.ts';
import { runScheduler } from '../server/scheduler-service.ts';
import { timeZone } from '../tools/dates.ts';

if (process.env.AUTH_MODE === 'demo') throw new Error('The demo runs no scheduler (AUTH_MODE=demo).');
// No fallback user: each run starts as its own user (db/scope.ts).
const store = openJobStore(undefined, { fallbackUid: null });
await store.ready;
const schedules = appSchedules(store);
const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const scheduler = await runScheduler({ store, schedules, appUrl: () => publicUrl, healthPort: Number(process.env.HEALTH_PORT ?? 5181) });
console.log(`Scheduler: time zone ${timeZone()}; from .env: ${schedules.map((j) => `${j.name} ${j.schedule.spec}`).join('; ') || 'nothing'}; health on 127.0.0.1:${scheduler.health?.port}`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await scheduler.stop();
  store.close();
  process.exit(0);
};
// void: shutdown ends the process either way.
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
