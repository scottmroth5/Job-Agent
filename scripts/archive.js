// Moves finished or stale jobs out of the pipeline (v1's archive rules).
//   npm run archive -- --dry-run    list what would move
//   npm run archive                 move them
import { createTracer } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.js';
import { archivePostings } from '../agents/hunt/archive.js';

const dryRun = process.argv.includes('--dry-run');
const store = openJobStore();
try {
  const run = dryRun ? null : createTracer({ store }).startRun('archive');
  const result = archivePostings(store.db, { dryRun });
  const after = dryRun ? result.remaining - result.archived.length : result.remaining;
  console.log(`${dryRun ? 'DRY RUN: would archive' : 'Archived'} ${result.archived.length} jobs; ${after} ${dryRun ? 'would remain' : 'remain'} in the pipeline.`);
  for (const m of result.archived) console.log(`  #${m.id} ${m.company} | ${m.title} (${m.reason})`);
  run?.finish('ok', { archived: result.archived.map(({ id, reason }) => ({ id, reason })), remaining: result.remaining });
} finally {
  store.close();
}
