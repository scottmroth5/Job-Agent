// Reads job-related Gmail, links it to applications, and updates status (forward only).
//   npm run inbox                                    new mail since the last run
//   npm run inbox:backfill                           the last 180 days (config/inbox.json backfillDays)
//   npm run inbox:backfill -- --days=30 --dry-run    count what would be classified and estimate the cost
// Output is counts, notices, and job titles only; email content is never printed.
import { createClaude, createTracer } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.js';
import { assertNoRunningRun } from '../tools/runs.js';
import { exitWhenDone } from '../tools/exit.js';
import { getInboxAuth } from '../tools/google/auth.js';
import { createGmail } from '../agents/inbox/gmail.js';
import { loadInboxConfig } from '../agents/inbox/config.js';
import { loadKey } from '../agents/inbox/crypto.js';
import { runInbox } from '../agents/inbox/process.js';
import { getPrompt } from '../agents/prompts.js';

const argv = process.argv.slice(2);
const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

async function main() {
  const cfg = loadInboxConfig();
  const mode = argv.includes('--backfill') ? 'backfill' : 'new';
  const days = get('days') ? Number(get('days')) : cfg.backfillDays;
  if (!(days > 0)) throw new Error('--days must be a positive number');
  const dryRun = argv.includes('--dry-run');
  const store = openJobStore();
  try {
    const key = dryRun ? null : loadKey();
    const gmail = createGmail({ auth: getInboxAuth(), onWait: (ms) => console.log(`Gmail rate limit reached; waiting ${ms / 1000} seconds, then continuing.`) });
    const name = mode === 'backfill' ? 'inbox-backfill' : 'inbox';
    if (!dryRun) assertNoRunningRun(store.db, name);
    const run = dryRun ? null : createTracer({ store }).startRun(name, { model: cfg.model, promptVersion: getPrompt(store.db, 'inbox-classify').version });
    try {
      const log = (level, m) => (run ? run.log(level, m) : console.log(m));
      const s = await runInbox({ store, gmail, claude: createClaude(), cfg, key, run, log, options: { mode, days, dryRun } });
      const totals = run?.finish(s.failures.length ? 'partial' : 'ok', { ...s, notices: s.notices.length });

      console.log(`\n${dryRun ? 'DRY RUN: ' : ''}${s.fetched} messages checked (${s.source}); ${s.alreadySeen} already processed, ${s.skipped} not job related.`);
      if (dryRun) {
        console.log(`${s.considered} would be classified with ${cfg.model}, about $${s.estimatedUsd.toFixed(2)}.`);
        return;
      }
      console.log(`${s.considered} job emails: ${s.matched} linked, ${s.opportunities} new opportunities, ${s.needsReview} need review.`);
      if (s.statusChanges.length) console.log(`Status changes: ${s.statusChanges.length}`);
      if (s.notices.length) {
        console.log(`\n${'='.repeat(60)}`);
        for (const n of s.notices) console.log(`  ${n}`);
        console.log('='.repeat(60));
      }
      if (s.needsReview) console.log('\nRun "npm run inbox:review" to resolve the emails that need review.');
      if (s.labelErrors) console.log(`${s.labelErrors} Gmail labels could not be added (the emails were still processed).`);
      if (s.failures.length) console.log(`${s.failures.length} emails failed to classify; the next run retries them.`);
      console.log(`Cost: $${totals.costUsd.toFixed(4)} (${totals.calls} Claude calls).`);
    } catch (err) {
      run?.finish('failed');
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
