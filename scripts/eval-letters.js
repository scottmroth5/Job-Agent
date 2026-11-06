// Letter fact check eval: recall on planted errors and false flags on clean letters, on synthetic cases
// (evals/letters/cases.json). Costs real money on the owner's key (about a cent or two a letter per model).
//   npm run eval:letters -- --dry-run                       the estimate only, no calls
//   npm run eval:letters -- --models=claude-haiku-4-5,claude-sonnet-5-5 --max-usd=1 [--verbose]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createJobTracer } from '../tools/trace.ts';
import { createJobClaude } from '../tools/claude.ts';
import { repoPath, dataPath } from '../tools/paths.ts';
import { openJobStore } from '../db/index.ts';
import { exitWhenDone } from '../tools/exit.ts';
import { VERIFY_MODEL } from '../agents/hunt/verify-letter.ts';
import { runLetterEval, estimateLetterEval } from '../evals/letters/run.js';

const argv = process.argv.slice(2);
/** @param {string} name */
const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
/** @param {number | null} x */
const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);

async function main() {
  const models = (get('models') ?? VERIFY_MODEL).split(',').map((m) => m.trim()).filter(Boolean);
  const maxUsd = Number(get('max-usd') ?? 1);
  const cases = JSON.parse(readFileSync(repoPath('evals', 'letters', 'cases.json'), 'utf8'));
  const store = openJobStore();
  try {
    const estimate = estimateLetterEval(cases, models, store.db);
    const total = Object.values(estimate).reduce((/** @type {number} */ s, x) => s + (x ?? 0), 0);
    for (const [m, usd] of Object.entries(estimate)) console.log(`${m}: ${cases.letters.length} letters, estimated $${usd == null ? '?' : usd.toFixed(3)}`);
    console.log(`Estimated total: $${total.toFixed(3)} (limit --max-usd=${maxUsd}).`);
    if (argv.includes('--dry-run')) return;
    if (total > maxUsd) throw new Error(`Estimated cost is over --max-usd=${maxUsd}.`);

    const run = createJobTracer({ store }).startRun('eval-letters', { models });
    try {
      const { perModel, promptVersion } = await runLetterEval({ cases, models, claude: createJobClaude(store.db), db: store.db, trace: run, log: argv.includes('--verbose') ? (m) => console.log(`  ${m}`) : () => {} });
      const totals = run.finish('ok', { models, promptVersion, ...Object.fromEntries(Object.entries(perModel).map(([m, r]) => [m, { recall: r.metrics.recall, falseFlagRate: r.metrics.falseFlagRate }])) });
      const dir = dataPath('evals', 'letters');
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/results-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ promptVersion, perModel }, null, 2));
      console.log(`\nPrompt ${promptVersion}`);
      for (const [m, { metrics: x }] of Object.entries(perModel)) {
        console.log(`\n${m}`);
        console.log(`  Planted errors found: ${x.found} of ${x.planted} (${pct(x.recall)}); by kind: ${Object.entries(x.byKind).map(([k, v]) => `${k} ${v.found}/${v.planted}`).join(', ')}`);
        if (x.missed.length) console.log(`  Missed: ${x.missed.join(', ')}`);
        console.log(`  Clean letters flagged: ${x.cleanFlagged.length} of ${x.clean} (${pct(x.falseFlagRate)})${x.cleanFlagged.length ? `: ${x.cleanFlagged.join(', ')}` : ''}`);
        console.log(`  Extra flags across all letters: ${x.extraFlags}; failed calls: ${x.failed}`);
        console.log(`  Cost per letter: $${x.costPerLetter.toFixed(4)}; average ${(x.avgMs / 1000).toFixed(1)} s`);
      }
      console.log(`\nTotal cost: $${totals.costUsd.toFixed(4)} (${totals.calls} Claude calls).`);
    } catch (err) {
      run.finish('failed');
      throw err;
    }
  } finally {
    store.close();
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => exitWhenDone());
