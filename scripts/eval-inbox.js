// Inbox eval: match and classification accuracy on synthetic labeled emails (evals/inbox/cases.json).
// Calls Claude once per pre-filtered case (about 40 Haiku calls, a few cents).
//   npm run eval:inbox -- [--model=claude-haiku-4-5] [--max-usd=0.25] [--verbose]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createJobTracer } from '../tools/trace.ts';
import { createJobClaude } from '../tools/claude.ts';
import { repoPath, dataPath } from '../tools/paths.ts';
import { openJobStore } from '../db/index.ts';
import { exitWhenDone } from '../tools/exit.ts';
import { loadInboxConfig } from '../agents/inbox/config.ts';
import { getPrompt } from '../agents/prompts.ts';
import { runInboxEval, estimateInboxEval } from '../evals/inbox/run.js';
import { inboxMetrics } from '../evals/inbox/metrics.js';
/** @import { ClassifiedResult } from '../evals/inbox/metrics.js' */

const argv = process.argv.slice(2);
/** @param {string} name */
const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
/** @param {number | null} x */
const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);

async function main() {
  const cfg = loadInboxConfig();
  const model = get('model') ?? cfg.model;
  const maxUsd = Number(get('max-usd') ?? 0.25);
  const { applications, cases } = JSON.parse(readFileSync(repoPath('evals', 'inbox', 'cases.json'), 'utf8'));
  const estimate = estimateInboxEval(cases, applications, cfg.bodyChars);
  console.log(`${cases.length} cases with ${model}; estimated cost at most $${estimate.toFixed(3)}.`);
  if (estimate > maxUsd) throw new Error(`Estimated cost is over --max-usd=${maxUsd}.`);

  const store = openJobStore();
  const promptVersion = getPrompt(store.db, 'inbox-classify').version;
  const run = createJobTracer({ store }).startRun('eval-inbox', { model, promptVersion });
  try {
    const results = await runInboxEval({ cases, applications, claude: createJobClaude(store.db), cfg, model, trace: run, log: argv.includes('--verbose') ? (m) => console.log(`  ${m}`) : () => {} });
    const m = inboxMetrics(results);
    const totals = run.finish('ok', { ...m, model, promptVersion });
    const dir = dataPath('evals', 'inbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/results-${new Date().toISOString().slice(0, 10)}-${model}.json`, JSON.stringify({ model, promptVersion, metrics: m, results }, null, 2));

    console.log(`\nModel ${model}, prompt ${promptVersion}`);
    console.log(`Pre-filter: kept ${pct(m.prefilterRecall)} of job emails, dropped ${pct(m.prefilterDropRate)} of non-job emails`);
    console.log(`Match accuracy:          ${pct(m.matchAccuracy)} of ${m.classified} classified emails (${m.wrongLinks} linked to the wrong application)`);
    console.log(`Classification accuracy: ${pct(m.classificationAccuracy)}`);
    console.log(`Sent to review: ${pct(m.reviewRate)}; matched by rule: ${pct(m.ruleMatchRate)}`);
    const classified = /** @type {ClassifiedResult[]} */ (results.filter((r) => r.passed)); // a passed email was classified
    const misses = classified.filter((r) => (r.predicted.type !== r.expected.type || (r.predicted.applicationId ?? null) !== (r.expected.applicationId ?? null)));
    if (misses.length) {
      console.log('\nMisses (synthetic case ids):');
      for (const r of misses) console.log(`  ${r.id}: expected ${r.expected.type} #${r.expected.applicationId ?? '-'}, got ${r.predicted.type} #${r.predicted.applicationId ?? '-'}${r.predicted.reviewStatus === 'needs_review' ? ' (review)' : ''}`);
    }
    const dropped = results.filter((r) => !r.passed && r.expected.type !== 'other').map((r) => r.id);
    if (dropped.length) console.log(`Job emails the pre-filter dropped: ${dropped.join(', ')}`);
    console.log(`\nCost: $${totals.costUsd.toFixed(4)} (${totals.calls} Claude calls).`);
  } catch (err) {
    run.finish('failed');
    throw err;
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
