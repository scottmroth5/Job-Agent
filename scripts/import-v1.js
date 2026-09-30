// One-time import of the v1 sheet exports (data/v1-export/sheets/*.csv) into data/job-agent.db.
//   npm run import:v1              import into a new, empty database
//   npm run import:v1 -- --reset   delete the database first, then import
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'csv-parse/sync';
import { createTracer } from '@scottmroth5/agent-core';
import { openJobStore, DB_PATH } from '../db/index.js';
import { importV1 } from '../db/import-v1.js';
import { repoPath } from '../tools/paths.js';

const SHEETS_DIR = repoPath('data', 'v1-export', 'sheets');

const readCsv = (path) =>
  parse(readFileSync(path), { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: false });

/**
 * Finds the exports by name: the Discovered Jobs sheet, and the hunt sheet tabs.
 * Hunt tabs are ordered archives first (by name) and the current "Jobs" tab last.
 */
export function classifySheetFiles(names) {
  const csv = names.filter((n) => n.toLowerCase().endsWith('.csv'));
  const discovered = csv.filter((n) => /^discovered/i.test(n));
  const hunt = csv.filter((n) => !/^discovered/i.test(n));
  const isCurrent = (n) => /- jobs\.csv$/i.test(n);
  return {
    discovered,
    hunt: [...hunt.filter((n) => !isCurrent(n)).sort(), ...hunt.filter(isCurrent)].map((name) => ({ name, current: isCurrent(name) })),
  };
}

function main() {
  if (!existsSync(SHEETS_DIR)) throw new Error(`No sheet exports found at ${SHEETS_DIR}.`);
  const files = classifySheetFiles(readdirSync(SHEETS_DIR));
  if (files.discovered.length !== 1) throw new Error(`Expected one Discovered Jobs CSV, found ${files.discovered.length}.`);
  if (!files.hunt.some((f) => f.current)) throw new Error('No current hunt tab found (a file ending in "- Jobs.csv").');

  if (process.argv.includes('--reset')) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
    console.log(`Deleted ${DB_PATH}`);
  }

  const store = openJobStore();
  const run = createTracer({ store }).startRun('import-v1', { files: files.hunt.length + 1 });
  try {
    const counts = importV1(
      store,
      {
        discovered: readCsv(join(SHEETS_DIR, files.discovered[0])),
        hunt: files.hunt.map((f) => ({ ...f, rows: readCsv(join(SHEETS_DIR, f.name)) })),
      },
      { runId: run.id },
    );
    run.finish('ok', { postings: counts.postingsCreated });

    console.log(`\nImported into ${DB_PATH}`);
    console.log(`  rows read: ${counts.discoveredRows} discovered, ${counts.huntRows} hunt (${files.hunt.map((f) => f.name).join(', ')})`);
    console.log(`  postings created: ${counts.postingsCreated} (${counts.manualPostings} only in the hunt sheets)`);
    console.log(`  duplicate discovered rows merged: ${counts.duplicateDiscoveredRows}; rows skipped (no company/title): ${counts.skippedRows}`);
    console.log(`  scores: ${counts.scores['v1-quick']} v1-quick, ${counts.scores['v1-analysis']} v1-analysis` +
      (counts.outOfRangeScores ? ` (${counts.outOfRangeScores} outside 1-10 not imported)` : ''));
    console.log(`  artifacts: ${counts.artifacts.analysis} analyses, ${counts.artifacts.resume_tweaks} resume tweaks, ${counts.artifacts.cover_letter} cover letter references`);
    console.log('  by stage and status:');
    for (const r of counts.byStageStatus) console.log(`    ${r.stage.padEnd(10)} ${r.status.padEnd(12)} ${r.n}`);
    console.log('  by source:');
    for (const r of counts.bySource) console.log(`    ${(r.source ?? '(none)').padEnd(18)} ${r.n}`);
    const unknown = Object.entries(counts.unknownStatuses);
    if (unknown.length) console.log(`  unrecognized statuses (imported as new): ${unknown.map(([s, n]) => `"${s}" x${n}`).join(', ')}`);
  } catch (err) {
    run.finish('failed');
    throw err;
  } finally {
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
