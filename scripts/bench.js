// Response-time benchmark (v3 Phase 3): times the main routes on the demo's sample database, in process through
// app.inject, so the async data layer can be compared with the synchronous one. Sample data only: it seeds a fresh
// demo database in the OS temp folder, deletes it afterwards, and touches no real data, network, or Claude.
//
//   node scripts/bench.js                 3 rounds of 200 timed runs per route, each after 20 warm-up runs
//   node scripts/bench.js --runs=500      more runs per round
//   node scripts/bench.js --rounds=5      more rounds
//   node scripts/bench.js --json          machine-readable output
//
// Prints median, p95, and mean milliseconds per route from its best round (the lowest median): a busy computer slows
// whole rounds, so the best round is the steadiest number to compare. Nothing is written to the repo or logged.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openJobStore } from '../db/index.ts';
import { buildApp } from '../server/app.ts';
import { DEMO_CONFIG, JOBS } from '../demo/sample-data.ts';
import { seedDemo } from './demo-seed.js';
/** @import { AppServices } from '../server/app.ts' */
/** @import { InjectOptions } from 'fastify' */

const arg = (/** @type {string} */ name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const RUNS = Number(arg('runs') ?? 200);
const ROUNDS = Math.max(1, Number(arg('rounds') ?? 3));
const WARMUP = 20;

/** Milliseconds at the given quantile of sorted times. @param {number[]} sorted @param {number} q */
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** @param {number[]} times */
function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const round = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;
  return { median: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)), mean: round(mean) };
}

const dir = mkdtempSync(join(tmpdir(), 'job-agent-bench-'));
try {
  const dbPath = join(dir, 'job-agent.db');
  await seedDemo({ dbPath, configPath: join(dir, 'config', 'job-search.json') });
  const store = openJobStore(dbPath);
  // Every outside service is off: the benchmarked routes never reach them.
  const services = /** @type {AppServices} */ (/** @type {unknown} */ ({
    claude: null,
    http: null,
    createBrowser: null,
    runScript: async () => ({ code: 1, lastError: 'off in the benchmark' }),
    runPipeline: async () => ({ code: 1, lastError: 'off in the benchmark' }),
    inbox: { ready: () => false, gmail: () => null, key: () => null, cfg: {} },
    knowledge: async () => '',
    log: { info() {}, warn() {}, error() {} },
  }));
  const app = await buildApp({ store, config: DEMO_CONFIG, services, authMode: 'none' });
  await app.ready();

  const job = /** @type {number} */ (await store.db.prepare('SELECT id FROM postings WHERE user_id = @uid ORDER BY id LIMIT 1').pluck().get());
  /** @type {Array<{ name: string, run: () => Promise<void> }>} */
  const routes = [];
  /** @param {string} name @param {InjectOptions} req @param {number} [status] */
  const route = (name, req, status = 200) =>
    routes.push({
      name,
      run: async () => {
        const res = await app.inject(req);
        if (res.statusCode !== status) throw new Error(`${name}: status ${res.statusCode}`);
      },
    });
  route('GET /api/summary', { url: '/api/summary' });
  route('GET /api/postings', { url: '/api/postings' });
  route('GET /api/postings/:id', { url: `/api/postings/${job}` });
  route('GET /api/funnel', { url: '/api/funnel' });
  route('GET /api/follow-ups', { url: '/api/follow-ups' });
  // A write: add a note, then delete it, so every run sees the same data.
  routes.push({
    name: 'POST + DELETE a note',
    run: async () => {
      const add = await app.inject({ method: 'POST', url: `/api/postings/${job}/notes`, payload: { body: 'Benchmark note' } });
      if (add.statusCode !== 201) throw new Error(`note add: status ${add.statusCode}`);
      const del = await app.inject({ method: 'DELETE', url: `/api/notes/${add.json().id}` });
      if (del.statusCode >= 300) throw new Error(`note delete: status ${del.statusCode}`);
    },
  });

  /** @type {Record<string, ReturnType<typeof stats>>} */
  const results = {};
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const r of routes) {
      for (let i = 0; i < WARMUP; i += 1) await r.run();
      /** @type {number[]} */
      const times = [];
      for (let i = 0; i < RUNS; i += 1) {
        const start = performance.now();
        await r.run();
        times.push(performance.now() - start);
      }
      const s = stats(times);
      if (!results[r.name] || s.median < results[r.name].median) results[r.name] = s;
    }
  }
  await app.close();
  store.close();

  if (process.argv.includes('--json')) console.log(JSON.stringify({ runs: RUNS, rounds: ROUNDS, jobs: JOBS.length, node: process.version, results }, null, 2));
  else {
    console.log(`Best of ${ROUNDS} rounds of ${RUNS} runs per route on the demo's ${JOBS.length} sample jobs (Node ${process.version}); milliseconds`);
    console.log('route'.padEnd(26) + 'median'.padStart(9) + 'p95'.padStart(9) + 'mean'.padStart(9));
    for (const [name, s] of Object.entries(results)) console.log(name.padEnd(26) + String(s.median).padStart(9) + String(s.p95).padStart(9) + String(s.mean).padStart(9));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
