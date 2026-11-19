// A worker service for test/roles.test.js (v3 Phase 7): runWorker, the code apps/worker.ts runs, with stand-in services,
// on the database at argv[2], for the pools in argv[3]. Claude is a fake that scores 8; the pipeline's discover step and
// any page fetch wait until they are stopped. It prints "ready <health port>" once it runs, and stops as apps/worker.ts
// does on SIGTERM (or on an IPC "stop", since Windows has no SIGTERM to catch), printing "stopped". Synthetic data only.
import { createClaude } from '@scottmroth5/agent-core';
import { openJobStore } from '../../db/index.ts';
import { runWorker } from '../../server/worker.ts';
import { graceMs, poolsFrom } from '../../server/roles.ts';
import { fakeConfig, fakeServices } from './fakes.js';

const [, , path, poolList] = process.argv;
// npm test (node --test) runs every .js file under test/, this one too: with no IPC channel and no database it is not
// a worker for test/roles.test.js, so it ends at once (its health server would otherwise keep it running forever).
if (!process.send || !path) process.exit(0);
// Listen for a stop before anything starts, so one sent while the worker is still starting is not lost; and leave if
// the test that started this process is gone (its IPC channel closed), so a failed test never leaves it running.
/** @type {null | (() => Promise<void>)} */
let shutdown = null;
let stopAsked = false;
const askStop = () => {
  stopAsked = true;
  if (shutdown) void shutdown();
};
process.on('SIGTERM', askStop);
process.on('message', (m) => m === 'stop' && askStop());
process.on('disconnect', () => process.exit(2));
const store = openJobStore(path, { fallbackUid: null });
await store.ready;
const client = {
  messages: {
    create: async (/** @type {{ model: string, output_config?: { format?: object } }} */ params) => {
      const data = { score: 8, fit: 'High', reason: 'Strong fit', whyItFits: 'w', caveats: '', rate: { min: null, max: null, unit: 'unknown' }, hoursPerWeek: { min: null, max: null }, roleType: 'Full time', locationConcern: 'none', strengths: ['Scale'], watchOuts: [], topTalkingPoint: 'Growth', suggestedStatus: 'worth_pursuing' };
      return { id: 'm', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: params.output_config?.format ? JSON.stringify(data) : 'Body paragraph.' }], usage: { input_tokens: 10, output_tokens: 5 } };
    },
  },
};
/** @type {(signal?: AbortSignal) => Promise<never>} */
const untilStopped = (signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
const services = fakeServices({
  claude: createClaude({ client }),
  knowledge: async () => 'Section 5: Job Targets. Engineering leadership. '.repeat(20),
  drive: null,
  http: { get: () => untilStopped(), sleep: async () => {} },
  createBrowser: async () => null,
  runPipeline: async ({ args = [], onLine, signal }) => {
    if (args.includes('--only=discover')) {
      onLine('[pipeline] Step 1/5: discover');
      await untilStopped(signal).catch(() => {});
      return { code: 1, lastError: 'Stopped.' };
    }
    return { code: 0, lastError: null };
  },
  queueOptions: { pollMs: 50, heartbeatMs: 200 },
  log: { info() {}, warn() {}, error() {} },
});
const pools = poolsFrom(poolList);
const worker = await runWorker({ store, config: fakeConfig({ candidate: { name: 'Pat Example' }, search: { homeLocations: [] }, fractional: {}, coverLetterChecks: [] }), services, pools, healthPort: 0 });
console.log(`ready ${worker.health?.port}`);

let stopping = false;
shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await worker.stop(graceMs(worker.service));
  store.close();
  console.log('stopped');
  process.exit(0);
};
if (stopAsked) void shutdown();
