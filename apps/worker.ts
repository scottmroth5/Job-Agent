// A worker service (v3 Phase 7): runs the tasks of the pools in POOLS (browser, ai, io, or several joined by commas;
// all three when unset) until docker stop's SIGTERM, then gives running tasks its grace period (server/roles.ts).
// HEALTH_PORT (default 5180) answers GET /healthz on 127.0.0.1 for Docker and deploy.sh.
import { loadConfig } from '../tools/config.ts';
import { openJobStore } from '../db/index.ts';
import { buildServices } from '../server/services.ts';
import { poolsFrom, graceMs } from '../server/roles.ts';
import { runWorker } from '../server/worker.ts';

if (process.env.AUTH_MODE === 'demo') throw new Error('The demo runs no workers (AUTH_MODE=demo).');
const pools = poolsFrom(process.env.POOLS);
// No fallback user: every task runs as its own user (db/scope.ts).
const store = openJobStore(undefined, { fallbackUid: null });
await store.ready;
const services = buildServices({ store, authConfig: { publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, '') }, demo: false });
const worker = await runWorker({ store, config: loadConfig(), services, pools, version: process.env.APP_VERSION ?? null, healthPort: Number(process.env.HEALTH_PORT ?? 5180) });
console.log(`Worker ${worker.service}: pools ${pools.join(', ')}; health on 127.0.0.1:${worker.health?.port}`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const grace = graceMs(worker.service);
  console.log(`[worker] stopping: running tasks get up to ${Math.round(grace / 1000)} seconds`);
  await worker.stop(grace);
  store.close();
  process.exit(0);
};
// void: shutdown ends the process either way.
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
