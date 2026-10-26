// A database is never changed by a migration without a checked copy first (db/index.js), and the pending check reports
// what would change without touching the real file. Synthetic temporary databases only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from '@scottmroth5/agent-core';
import { loadMigrations, openJobStore, pendingMigrations, pruneMigrationCopies } from '../db/index.js';

/** A database file with every migration but the last, holding one job. */
function olderDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'ja-migrate-'));
  const path = join(dir, 'job-agent.db');
  const all = loadMigrations();
  const store = openStore(path, { app: 'job-agent', migrations: all.slice(0, -1) });
  store.db.prepare(`INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at)
    VALUES ('k', 'Example Co', 'CTO', 'example|cto', '2026-10-01', 'pipeline', 'new', 'x', 'x')`).run();
  store.close();
  return { dir, path, last: all.at(-1).id };
}
const copiesIn = (dir) => (existsSync(join(dir, 'backups')) ? readdirSync(join(dir, 'backups')).filter((n) => n.startsWith('pre-migration-')) : []);

test('the pending check lists what would change and leaves the real file alone', () => {
  const { dir, path, last } = olderDatabase();
  const temp = mkdtempSync(join(tmpdir(), 'ja-pending-'));
  assert.deepEqual(pendingMigrations(path, temp).pending, [`job-agent:${last}`]);
  assert.deepEqual(readdirSync(temp), [], 'the throwaway copy is deleted');
  assert.deepEqual(pendingMigrations(path, temp).pending, [`job-agent:${last}`], 'still pending: the real file was not migrated');
  assert.deepEqual(copiesIn(dir), []);
  assert.deepEqual(pendingMigrations(join(dir, 'missing.db'), temp).pending, [], 'no database yet: nothing to change');
});

test('opening a database that needs a migration takes a checked copy first; an up-to-date one takes none', () => {
  const { dir, path, last } = olderDatabase();
  const logged = [];
  const store = openJobStore(path, { log: { info: (m) => logged.push(m) } });
  store.close();
  const copies = copiesIn(dir);
  assert.equal(copies.length, 1);
  assert.match(logged[0], new RegExp(`applying ${last}`));
  const copy = new Database(join(dir, 'backups', copies[0]), { readonly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) FROM schema_migrations WHERE id = ?").pluck().get(last), 0, 'the copy is the database before the migration');
  assert.equal(copy.prepare('SELECT COUNT(*) FROM postings').pluck().get(), 1, 'with its data');
  copy.close();

  openJobStore(path).close();
  assert.equal(copiesIn(dir).length, 1, 'nothing pending: no new copy');
  assert.deepEqual(pendingMigrations(path, mkdtempSync(join(tmpdir(), 'ja-pending-'))).pending, []);
});

test('only the newest five pre-migration copies are kept, and other files are never touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ja-prune-'));
  const names = Array.from({ length: 7 }, (_, i) => `pre-migration-2026102${i}T120000000Z.db`);
  for (const n of [...names, 'job-agent-before-012-2026-10-16.db', 'notes.txt']) writeFileSync(join(dir, n), 'x');
  pruneMigrationCopies(dir);
  const left = readdirSync(dir).sort();
  assert.deepEqual(left, [...names.slice(2), 'job-agent-before-012-2026-10-16.db', 'notes.txt'].sort());
});
