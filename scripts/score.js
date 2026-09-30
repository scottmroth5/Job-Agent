// Scores postings found by discovery and promotes high scores to the pipeline.
//   npm run score                         score every unscored v2 posting
//   npm run score -- --dry-run            list what would be scored and an estimated cost
//   npm run score -- --model=claude-sonnet-5-5 --limit=10 --ids=12,15 --all-unscored
import { createClaude, createTracer } from '@scottmroth5/agent-core';
import { loadConfig } from '../tools/config.js';
import { loadKnowledge } from '../tools/knowledge.js';
import { assertNoRunningRun } from '../tools/runs.js';
import { openJobStore } from '../db/index.js';
import { exitWhenDone } from '../tools/exit.js';
import {
  DEFAULT_SCORE_MODEL,
  MODEL_SETTINGS,
  PROMOTE_AT,
  estimateCost,
  loadScorePrompt,
  scorePostings,
  selectPostings,
} from '../agents/discovery/score.js';

function parseArgs(argv) {
  const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const model = get('model') ?? process.env.SCORE_MODEL ?? DEFAULT_SCORE_MODEL;
  if (!MODEL_SETTINGS[model]) throw new Error(`Unknown model "${model}". Known: ${Object.keys(MODEL_SETTINGS).join(', ')}`);
  return {
    dryRun: argv.includes('--dry-run'),
    allUnscored: argv.includes('--all-unscored'),
    limit: get('limit') ? Number(get('limit')) : undefined,
    ids: get('ids')?.split(',').map(Number).filter(Number.isFinite),
    model,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = openJobStore();
  try {
    if (args.dryRun) {
      const postings = selectPostings(store.db, args);
      const rule = postings.filter((p) => p.location_check === 'conflict').length;
      const usd = estimateCost(postings, { model: args.model, knowledgeChars: 10000, templateChars: loadScorePrompt().template.length });
      console.log(`DRY RUN: ${postings.length} postings to score with ${args.model} (${rule} by location rule, no AI call).`);
      console.log(`Estimated cost: about $${usd.toFixed(2)}.`);
      const byCheck = {};
      for (const p of postings) byCheck[p.location_check ?? 'none'] = (byCheck[p.location_check ?? 'none'] ?? 0) + 1;
      console.log(`By location check: ${Object.entries(byCheck).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      return;
    }

    assertNoRunningRun(store.db, 'score');
    const knowledge = await loadKnowledge();
    console.log(`Candidate Knowledge loaded: ${knowledge.length.toLocaleString()} characters.`);
    const run = createTracer({ store }).startRun('score', { model: args.model, promptVersion: loadScorePrompt().version });
    try {
      const summary = await scorePostings({
        store,
        config,
        claude: createClaude(),
        knowledge,
        model: args.model,
        run,
        options: { ids: args.ids, allUnscored: args.allUnscored, limit: args.limit },
      });
      const totals = run.finish(summary.aborted ? 'aborted' : summary.failures.length ? 'partial' : 'ok', summary);

      console.log(`\nScored ${summary.scored} of ${summary.selected} postings with ${args.model} (${summary.ruleScored} by location rule).`);
      const dist = Object.entries(summary.distribution).sort(([a], [b]) => b - a).map(([s, n]) => `${s}: ${n}`).join('  ');
      console.log(`Scores: ${dist || 'none'}`);
      console.log(`Promoted to pipeline (score ${PROMOTE_AT}+): ${summary.promoted.length}`);
      if (summary.failures.length) {
        console.log(`Failures: ${summary.failures.length} (left unscored; the next run retries them)`);
        for (const f of summary.failures.slice(0, 5)) console.log(`  posting ${f.id}: ${f.error}`);
      }
      if (summary.aborted) console.log('Stopped early after repeated failures. Check the API key and network.');
      console.log(`Cost: $${totals.costUsd.toFixed(4)} (${totals.calls} Claude calls, ${totals.cacheReadTokens} cached input tokens).`);
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
  .finally(exitWhenDone);
