// store.admin is the unscoped database (v3 Phase 3): a query on it is not bound to the current user, so it must name
// its user itself or be a cross-user read the admin is allowed. Its callers are listed here; a new one is a deliberate
// change to this list, never a quiet way around user scoping (test/user-scope.test.js checks the SQL itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FOLDERS = ['agents', 'server', 'tools', 'demo', 'scripts', 'db', 'evals'];
/** Each file that uses store.admin, and why. */
const ALLOWED = {
  'db/index.ts': 'makes it',
  'server/app.ts': "each user's settings, knowledge doc, and setup by user id (configFor, backgroundFor), the scheduled users' list, the app-wide usage totals, and the admin's cross-user reads (server/admin-queries.ts)",
  'server/main.ts': 'the owner email at startup, and the allowance notice by user id',
  'scripts/add.js': "the owner's settings (configFor names its user)",
  'scripts/cleanup.js': "the owner's settings (configFor names its user)",
  'scripts/discover.js': "the owner's settings (configFor names its user)",
  'scripts/hunt.js': "the owner's settings (configFor names its user)",
  'scripts/score.js': "the owner's settings (configFor names its user)",
  'scripts/pipeline.js': "the user's settings and account checks (configFor and getUser name their user)",
  'scripts/backup-verify.js': 'table counts for the restore test',
  'scripts/db-types.js': 'the schema (sqlite_master) of a throwaway database',
  'tools/knowledge.ts': "the owner's knowledge doc (backgroundFor names its user)",
};

/** @param {string} dir @returns {string[]} */
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : files(p);
    return /\.(ts|js)$/.test(name) ? [p.replace(/\\/g, '/')] : [];
  });

test('store.admin is used only where a query names its own user or reads across users for the admin', () => {
  const users = FOLDERS.flatMap(files).filter((f) => /\bstore\.admin\b|\badmin: \w+ \}|\{ admin\b/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(users.filter((f) => !(f in ALLOWED)), [], 'a new store.admin caller: add it to ALLOWED with its reason');
  assert.deepEqual(Object.keys(ALLOWED).filter((f) => !users.includes(f)), [], 'a listed file no longer uses store.admin: take it off the list');
});
