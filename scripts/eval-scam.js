// Scam warning eval: the free rules' recall and false flags, then (without --dry-run) the Claude check on the cases the
// rules flag, on synthetic postings (evals/scam/cases.json). The model run costs real money on the owner's key
// (well under a cent a case on Haiku).
//   npm run eval:scam -- --dry-run                        the rules and the estimate only: no calls, no database
//   npm run eval:scam -- --models=claude-haiku-4-5,claude-sonnet-5-5 --max-usd=1 [--verbose]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createJobTracer } from '../tools/trace.ts';
import { createJobClaude } from '../tools/claude.ts';
import { repoPath, dataPath } from '../tools/paths.ts';
import { openJobStore } from '../db/index.ts';
import { exitWhenDone } from '../tools/exit.ts';
import { SCAM_MODEL } from '../agents/discovery/scam.ts';
import { estimateScamEval, ruleMetrics, runScamEval } from '../evals/scam/run.js';
import { unpriced } from '../evals/estimate.js';

const argv = process.argv.slice(2);
/** @param {string} name */
const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

async function main() {
  const models = (get('models') ?? SCAM_MODEL).split(',').map((m) => m.trim()).filter(Boolean);
  const maxUsd = Number(get('max-usd') ?? 1);
  const cases = JSON.parse(readFileSync(repoPath('evals', 'scam', 'cases.json'), 'utf8'));

  const rules = ruleMetrics(cases);
  console.log(`Rules: flagged ${rules.scamsFlagged} of ${rules.scams} scams; flagged ${rules.realFlagged.length} of ${rules.real} real-looking postings.`);
  if (rules.missed.length) console.log(`  Scams the rules missed: ${rules.missed.join(', ')}`);
  if (rules.realFlagged.length) console.log(`  Real postings flagged (sent to the model): ${rules.realFlagged.join(', ')}`);

  // A dry run never opens the database (no migrations, nothing read): it estimates from the repo's prompt.
  const dryRun = argv.includes('--dry-run');
  const store = dryRun ? null : openJobStore();
  try {
    const estimate = await estimateScamEval(cases, models, store?.db ?? null);
    const total = Object.values(estimate).reduce((/** @type {number} */ s, x) => s + (x ?? 0), 0);
    for (const [m, usd] of Object.entries(estimate)) console.log(`${m}: ${rules.flaggedIds.length} flagged cases, estimated $${usd == null ? '?' : usd.toFixed(3)}`);
    console.log(`Estimated total: $${total.toFixed(3)} (limit --max-usd=${maxUsd}).`);
    if (!store) return;
    const noPrice = unpriced(estimate);
    if (noPrice.length) throw new Error(`No price for ${noPrice.join(', ')} in evals/scam/run.js ESTIMATE_RATES, so --max-usd cannot be checked. Add its rates first.`);
    if (total > maxUsd) throw new Error(`Estimated cost is over --max-usd=${maxUsd}.`);

    const run = await createJobTracer({ store }).startRun('eval-scam', { models });
    try {
      const { perModel, real, promptVersion } = await runScamEval({ cases, models, claude: createJobClaude(store.db), db: store.db, trace: run, log: argv.includes('--verbose') ? (m) => console.log(`  ${m}`) : () => {} });
      const totals = await run.finish('ok', { models, promptVersion, ...Object.fromEntries(Object.entries(perModel).map(([m, r]) => [m, { scamsWarned: r.scamsWarned, realWarned: r.realWarned.length }])) });
      const dir = dataPath('evals', 'scam');
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/results-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ promptVersion, rules, perModel }, null, 2));
      console.log(`\nPrompt ${promptVersion}`);
      for (const [m, r] of Object.entries(perModel)) {
        console.log(`\n${m}`);
        console.log(`  Scams warned (medium or high): ${r.scamsWarned} of ${r.scams}${r.missed.length ? `; missed: ${r.missed.join(', ')}` : ''}`);
        console.log(`  Real postings warned: ${r.realWarned.length} of ${real}${r.realWarned.length ? `: ${r.realWarned.join(', ')}` : ''}`);
        console.log(`  Failed calls: ${r.failed}`);
      }
      console.log(`\nTotal cost: $${totals.costUsd.toFixed(4)} (${totals.calls} Claude calls).`);
    } catch (err) {
      await run.finish('failed');
      throw err;
    }
  } finally {
    store?.close();
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => exitWhenDone());
