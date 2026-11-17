// A worker process for test/queue-kill.test.js: opens the database at argv[2], takes the waiting refetch and score
// tasks, writes a line and opens a run for each, prints "running" once both have started, and then hangs until it is
// killed. Synthetic tasks only.
import { openJobStore } from '../../db/index.ts';
import { createQueue } from '../../tools/queue/queue.ts';

const store = openJobStore(process.argv[2]);
await store.ready;
const queue = createQueue({ db: store.admin, worker: 'doomed', pollMs: 50, heartbeatMs: 3_600_000, log: { info() {}, warn() {} } });
let started = 0;
/** @type {import('../../tools/queue/queue.ts').Handler} */
const hang = async ({ job, logger, setRunId }) => {
  logger.info(`working on ${job.type}`);
  const run = await store.admin.prepare("INSERT INTO runs (name, status, started_at, user_id) VALUES (?, 'running', ?, ?) RETURNING id").run(`ui-${job.type}`, new Date().toISOString(), job.userId);
  await setRunId(Number(run.id));
  if (++started === 2) console.log('running');
  return await new Promise(() => {}); // until the process is killed
};
queue.start({ refetch: hang, score: hang });
