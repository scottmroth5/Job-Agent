// The tests skipped on PostgreSQL (test/fixtures/engine.js sqliteOnly) are a short, reviewed list: each one is about
// something only SQLite has (its old migrations, its file copies and backups) and gets a PostgreSQL version in Phase 5
// or never needs one. A new skip is added here with its reason, never quietly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoPath } from '../tools/paths.ts';

/** File: how many of its tests are skipped on PostgreSQL. */
const EXPECTED = {
  'demo.test.js': 1, // the demo seed checks its SQLite file until the demo moves to PGlite (PR 5)
  'migration-backup.test.js': 2, // db:pending and the pre-migration copy work on the SQLite file (Phase 5)
  'migrations-users.test.js': 1, // 013 rebuilt SQLite tables; PostgreSQL starts from the baseline
  'notes.test.js': 1, // 025 numbered SQLite rows by rowid; PostgreSQL starts from the baseline
  'report-baseline.test.js': 2, // report:baseline reads the SQLite file (Phase 5)
  'restore-test.test.js': 2, // backups are of the SQLite file (pg_dump in Phase 5)
};

test('the tests skipped on PostgreSQL are the reviewed list', () => {
  const dir = repoPath('test');
  /** @type {Record<string, number>} */
  const found = {};
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.test.js'))) {
    const count = (readFileSync(join(dir, name), 'utf8').match(/skip: sqliteOnly\(/g) ?? []).length;
    if (count) found[name] = count;
  }
  assert.deepEqual(found, EXPECTED);
});
