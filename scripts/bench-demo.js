// Response times of the public demo (v3 Phase 3): a few read requests to a demo address given on the command line,
// timed from this computer, to compare before and after a deploy. The demo runs the same code on sample data and
// is read-only, so this changes nothing there. The address is never written in the repo.
//
//   node scripts/bench-demo.js --url=https://demo.example.com            10 runs per route
//   node scripts/bench-demo.js --url=https://demo.example.com --runs=20
//
// Times include the network, so compare runs from the same place. Keep runs small: the demo caps requests per address.
import { performance } from 'node:perf_hooks';

const arg = (/** @type {string} */ name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const base = arg('url');
const RUNS = Math.min(Number(arg('runs') ?? 10), 50);
if (!base || !/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/bench-demo.js --url=https://<demo address> [--runs=10]');
  process.exit(1);
}

/** @param {number[]} times */
function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (/** @type {number} */ q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { median: Math.round(at(0.5)), p95: Math.round(at(0.95)) };
}

/** @param {string} path */
async function get(path) {
  const res = await fetch(new URL(path, base), { headers: { accept: 'application/json', 'user-agent': 'job-agent-bench' } });
  if (!res.ok) throw new Error(`${path}: status ${res.status}`);
  return res.json();
}

const postings = /** @type {Array<{ id: number }>} */ (await get('/api/postings'));
const job = postings[0]?.id;
const paths = ['/api/summary', '/api/postings', ...(job ? [`/api/postings/${job}`] : []), '/api/funnel'];

console.log(`${RUNS} runs per route; milliseconds, network included`);
console.log('route'.padEnd(26) + 'median'.padStart(9) + 'p95'.padStart(9));
for (const path of paths) {
  /** @type {number[]} */
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    const start = performance.now();
    await get(path);
    times.push(performance.now() - start);
  }
  const s = stats(times);
  console.log(path.replace(/\/\d+$/, '/:id').padEnd(26) + String(s.median).padStart(9) + String(s.p95).padStart(9));
}
