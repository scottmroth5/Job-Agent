// Removes saved "jobs" that are really lists of jobs (search pages, "CTO Jobs and Vacancies").
// They are archived and marked passed with a note, not deleted, so they are never added again.
//   npm run remove-listings -- --dry-run    list what would be removed
//   npm run remove-listings                 remove them
import { createTracer } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.js';
import { archiveListings } from '../agents/hunt/archive.js';

const dryRun = process.argv.includes('--dry-run');
const store = openJobStore();
try {
  const run = dryRun ? null : createTracer({ store }).startRun('remove-listings');
  const { archived } = archiveListings(store.db, { dryRun });
  console.log(`${dryRun ? 'DRY RUN: would remove' : 'Removed'} ${archived.length} list-of-jobs pages.`);
  for (const p of archived) console.log(`  #${p.id} [${p.stage}/${p.status}] ${p.title} (${p.reason})`);
  run?.finish('ok', { removed: archived.map(({ id }) => id) });
} finally {
  store.close();
}
