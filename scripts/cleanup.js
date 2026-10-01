// Tidies saved jobs after a rule change:
//   - archives extra copies of a job (same company and title; the copy you acted on is kept)
//   - archives list-of-jobs pages and jobs from search.excludedSites (marked passed with a note, not deleted,
//     so they are recognized and never added again)
//   - moves untouched pipeline jobs with no description back to Discovered, where the UI flags them
//   npm run cleanup -- --dry-run    list what would change
//   npm run cleanup                 change it
import { createTracer } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.js';
import { loadConfig } from '../tools/config.js';
import { archiveListings, demoteWithoutText } from '../agents/hunt/archive.js';

const dryRun = process.argv.includes('--dry-run');
const config = loadConfig();
const store = openJobStore();
try {
  const run = dryRun ? null : createTracer({ store }).startRun('cleanup');
  const { archived } = archiveListings(store.db, { config, dryRun });
  const { demoted } = demoteWithoutText(store.db, { dryRun });
  const verb = (would, did) => (dryRun ? `DRY RUN: would ${would}` : did);
  console.log(`${verb('remove', 'Removed')} ${archived.length} list pages, excluded-site jobs, and duplicates.`);
  for (const p of archived) console.log(`  #${p.id} [${p.stage}/${p.status}] ${p.title} (${p.reason})`);
  console.log(`${verb('move', 'Moved')} ${demoted.length} pipeline jobs without a description back to Discovered.`);
  for (const p of demoted) console.log(`  #${p.id} ${p.title}`);
  run?.finish('ok', { removed: archived.map(({ id }) => id), demoted: demoted.map(({ id }) => id) });
} finally {
  store.close();
}
