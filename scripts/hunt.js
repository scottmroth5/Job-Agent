// Resume tweaks and cover letters for promoted jobs.
//   npm run hunt                         everything promoted that is missing tweaks, a letter, or a letter Doc
//   npm run hunt -- --dry-run            what would be written, with an estimated cost
//   npm run hunt -- --ids=12,15          specific postings (scored first if needed); add --regenerate for new versions
//   npm run hunt -- --no-docs            store letters without creating Google Docs
import { createClaude, createTracer } from '@scottmroth5/agent-core';
import { loadConfig } from '../tools/config.js';
import { loadKnowledge } from '../tools/knowledge.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { createDriveClient } from '../tools/google/drive.js';
import { assertNoRunningRun } from '../tools/runs.js';
import { openJobStore } from '../db/index.js';
import { scorePostings, DEFAULT_SCORE_MODEL } from '../agents/discovery/score.js';
import { generateForPostings, selectForHunt, estimateHuntCost } from '../agents/hunt/generate.js';

function parseArgs(argv) {
  const ids = argv.find((a) => a.startsWith('--ids='))?.split('=')[1]?.split(',').map(Number).filter(Number.isFinite);
  const regenerate = argv.includes('--regenerate');
  if (regenerate && !ids?.length) throw new Error('--regenerate needs --ids so existing letters are never replaced wholesale.');
  return { dryRun: argv.includes('--dry-run'), docs: !argv.includes('--no-docs'), ids, regenerate };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = openJobStore();
  try {
    if (args.dryRun) {
      const postings = selectForHunt(store.db, { ids: args.ids });
      console.log(`DRY RUN: ${postings.length} postings need tweaks, a letter, or a letter Doc.`);
      for (const p of postings) {
        const needs = [!p.has_tweaks && 'tweaks', !p.has_letter && 'letter', p.letter_missing_doc && 'Doc only'].filter(Boolean).join(', ');
        console.log(`  #${p.id} score ${p.v2_score ?? '-'}: ${needs || (args.regenerate ? 'regenerate' : 'nothing')}`);
      }
      console.log(`Estimated cost: about $${estimateHuntCost(postings, 10000).toFixed(2)}.`);
      return;
    }

    assertNoRunningRun(store.db, 'hunt');
    const auth = getGoogleAuth();
    const knowledge = await loadKnowledge({ auth });
    const claude = createClaude();
    const tracer = createTracer({ store });

    if (args.ids?.length) {
      const scoreRun = tracer.startRun('score', { ids: args.ids });
      const s = await scorePostings({ store, config, claude, knowledge, model: DEFAULT_SCORE_MODEL, run: scoreRun, options: { ids: args.ids } });
      scoreRun.finish(s.failures.length ? 'partial' : 'ok', s);
      if (s.scored) console.log(`Scored ${s.scored} of the requested postings first.`);
    }

    const run = tracer.startRun('hunt', { ids: args.ids ?? null, regenerate: args.regenerate });
    try {
      const summary = await generateForPostings({
        store,
        config,
        claude,
        knowledge,
        drive: args.docs ? createDriveClient(auth) : null,
        run,
        options: { ids: args.ids, regenerate: args.regenerate },
      });
      const totals = run.finish(summary.aborted ? 'aborted' : summary.failures.length || summary.docFailures.length ? 'partial' : 'ok', summary);
      console.log(`\n${summary.selected} postings: ${summary.tweaks} resume tweaks, ${summary.letters} cover letters, ${summary.docs} Google Docs.`);
      for (const f of summary.flagged) console.log(`  #${f.id} letter needs review: ${f.flags.join('; ')}`);
      for (const f of summary.docFailures) console.log(`  #${f.id} Doc not saved (${f.error}); the next run retries it.`);
      for (const f of summary.failures) console.log(`  #${f.id} failed: ${f.error}`);
      for (const s of summary.skipped) console.log(`  #${s.id} skipped: ${s.reason}`);
      if (summary.aborted) console.log('Stopped early after repeated failures.');
      console.log(`Cost: $${totals.costUsd.toFixed(4)} (${totals.calls} Claude calls).`);
    } catch (err) {
      run.finish('failed');
      throw err;
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
