// Scoring eval: compare models on past postings you applied to or passed on.
//   npm run eval:score -- --build                     create data/evals/score/cases.jsonl (no Claude calls)
//   npm run eval:score -- --rebuild                   recreate the cases
//   npm run eval:score -- --models=claude-haiku-4-5,claude-sonnet-5-5 [--max-usd=2] [--limit=N]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createClaude, createTracer } from '@scottmroth5/agent-core';
import { loadConfig } from '../tools/config.js';
import { createHttp } from '../tools/http.js';
import { createBrowser } from '../tools/browser.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { readDoc } from '../tools/google/docs.js';
import { repoPath } from '../tools/paths.js';
import { openJobStore } from '../db/index.js';
import { MODEL_SETTINGS, MIN_KNOWLEDGE_CHARS, PROMOTE_AT } from '../agents/discovery/score.js';
import { buildCases } from '../evals/score/build-cases.js';
import { runEval, estimateEval } from '../evals/score/run.js';

const DIR = repoPath('data', 'evals', 'score');
const CASES = `${DIR}/cases.jsonl`;

const get = (argv, name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);
const num = (x) => (x == null ? '-' : x.toFixed(2));

async function build(rebuild) {
  if (existsSync(CASES) && !rebuild) throw new Error(`${CASES} already exists. Use --rebuild to recreate it.`);
  const config = loadConfig();
  const store = openJobStore();
  const browser = await createBrowser();
  try {
    const { cases, skipped, fetched } = await buildCases({ db: store.db, http: createHttp(), browser, config });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CASES, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
    const count = (l) => cases.filter((c) => c.label === l).length;
    console.log(`Wrote ${cases.length} cases to ${CASES}: ${count('applied')} applied, ${count('passed')} passed.`);
    console.log(`Text: ${cases.length - fetched} from pasted descriptions, ${fetched} fetched again; ${skipped.noText} skipped with no text.`);
    console.log(`With a v1 score: ${cases.filter((c) => c.v1Score != null).length}.`);
  } finally {
    await browser?.close();
    store.close();
  }
}

async function evaluate(argv) {
  if (!existsSync(CASES)) throw new Error('No eval cases yet. Run: npm run eval:score -- --build');
  const models = (get(argv, 'models') ?? 'claude-haiku-4-5,claude-sonnet-5-5').split(',').map((m) => m.trim());
  const unknown = models.filter((m) => !MODEL_SETTINGS[m]);
  if (unknown.length) throw new Error(`Unknown model(s): ${unknown.join(', ')}`);
  const maxUsd = Number(get(argv, 'max-usd') ?? 2);
  const limit = get(argv, 'limit') ? Number(get(argv, 'limit')) : undefined;
  let cases = readFileSync(CASES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (limit) cases = cases.slice(0, limit);

  const config = loadConfig();
  const { text: knowledge } = await readDoc(getGoogleAuth(), process.env.YOUR_KNOWLEDGE_DOC_ID);
  if (knowledge.length < MIN_KNOWLEDGE_CHARS) throw new Error('Candidate Knowledge doc is too short.');

  const estimate = estimateEval(cases, models, knowledge.length);
  const total = Object.values(estimate).reduce((a, b) => a + b, 0);
  console.log(`${cases.length} cases x ${models.length} models. Estimated cost: ${Object.entries(estimate).map(([m, u]) => `${m} ~$${u.toFixed(2)}`).join(', ')} (total ~$${total.toFixed(2)}).`);
  if (total > maxUsd) throw new Error(`Estimate is over the $${maxUsd.toFixed(2)} budget. Raise --max-usd or use --limit.`);

  const store = openJobStore();
  const run = createTracer({ store }).startRun('eval-score', { models, cases: cases.length });
  try {
    const result = await runEval({ cases, models, claude: createClaude(), config, knowledge, run, log: (m) => console.log(`  ${m}`) });
    const totals = run.finish('ok', { models, cases: cases.length });

    const rows = [
      { scorer: 'v1 (stored scores)', ...result.v1, cost: '-', 'avg ms': '-' },
      ...models.map((m) => ({ scorer: m, ...result.perModel[m].summary, cost: `$${result.perModel[m].costUsd.toFixed(3)}`, 'avg ms': result.perModel[m].avgMs })),
    ].map((r) => ({
      scorer: r.scorer,
      scored: `${r.scored}/${r.cases}`,
      'pairwise accuracy': pct(r.pairwiseAccuracy),
      'mean applied': num(r.meanApplied),
      'mean passed': num(r.meanPassed),
      [`applied ${PROMOTE_AT}+`]: pct(r.appliedPromoted),
      [`passed ${PROMOTE_AT}+`]: pct(r.passedPromoted),
      cost: r.cost,
      'avg ms': r['avg ms'],
    }));
    console.table(rows);
    console.log('Pairwise accuracy: how often a job you applied to scored above one you passed on (50% = chance).');
    console.log(`Total cost: $${totals.costUsd.toFixed(3)}.`);

    const file = `${DIR}/results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(file, JSON.stringify({ models, promptVersion: result.promptVersion, v1: result.v1, perModel: result.perModel }, null, 2));
    console.log(`Details saved to ${file}`);
  } catch (err) {
    run.finish('failed');
    throw err;
  } finally {
    store.close();
  }
}

const argv = process.argv.slice(2);
(argv.includes('--build') || argv.includes('--rebuild') ? build(argv.includes('--rebuild')) : evaluate(argv)).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
