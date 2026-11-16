// Moves finished or stale jobs out of the pipeline (v1's archive rules).
//   npm run archive -- --dry-run    list what would move
//   npm run archive                 move them
//   npm run archive -- --long-links [--dry-run]   archive the jobs whose link was too long to keep as its key (their key
//                                   ends in #sha256=; tools/urls.ts capUrlKey); counts and job ids only
import { createJobTracer } from '../tools/trace.ts';
import { openJobStore } from '../db/index.ts';
import { archiveLongLinks, archivePostings } from '../agents/hunt/archive.ts';

// An option this version does not know stops it before anything moves (an older copy once ran the plain archive
// when given --long-links).
const OPTIONS = ['--dry-run', '--long-links'];
const unknown = process.argv.slice(2).filter((a) => !OPTIONS.includes(a));
if (unknown.length) {
  console.error(`archive: unknown option ${unknown.join(' ')}; nothing was moved. Options: ${OPTIONS.join(' ')}`);
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
const store = openJobStore();
try {
  if (process.argv.includes('--long-links')) {
    const run = dryRun ? null : await createJobTracer({ store }).startRun('archive');
    const result = await archiveLongLinks(store.db, { dryRun });
    const ids = result.archived.map((p) => `#${p.id}`).join(', ');
    console.log(`${dryRun ? 'DRY RUN: would archive' : 'Archived'} ${result.archived.length} jobs with a link too long to match${ids ? ` (${ids})` : ''}.`);
    if (result.inProgress) console.log(`Left alone: ${result.inProgress} in progress.`);
    await run?.finish('ok', { longLinks: result.archived.length, inProgress: result.inProgress });
  } else {
    const run = dryRun ? null : await createJobTracer({ store }).startRun('archive');
    const result = await archivePostings(store.db, { dryRun });
    const after = dryRun ? result.remaining - result.archived.length : result.remaining;
    console.log(`${dryRun ? 'DRY RUN: would archive' : 'Archived'} ${result.archived.length} jobs; ${after} ${dryRun ? 'would remain' : 'remain'} in the pipeline.`);
    for (const m of result.archived) console.log(`  #${m.id} ${m.company} | ${m.title} (${m.reason})`);
    await run?.finish('ok', { archived: result.archived.map(({ id, reason }) => ({ id, reason })), remaining: result.remaining });
  }
} finally {
  store.close();
}
