import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@scottmroth5/agent-core';
import { openJobStore, loadMigrations } from '../db/index.js';
import { listPostings } from '../server/queries.js';
import { archivePostings } from '../agents/hunt/archive.js';

// Synthetic data only.
test('the duplicate status is allowed and closes a job like passed', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const id = Number(
    db
      .prepare(`INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at)
        VALUES ('k', 'Example Co', 'CTO', 'k', '2026-10-01', 'pipeline', 'duplicate', 'x', 'x')`)
      .run().lastInsertRowid,
  );
  assert.throws(() => db.prepare("UPDATE postings SET status = 'maybe' WHERE id = ?").run(id), /status is not in the status list/);
  assert.deepEqual(listPostings(db, { status: 'active' }), []);
  assert.deepEqual(listPostings(db, { status: 'progress' }), []);
  assert.equal(archivePostings(db).archived[0].reason, 'status duplicate');
  store.close();
});

test('migration 008 loosens the status constraint in place without losing rows, links, or indexes, and relabels cleanup copies', () => {
  const before = loadMigrations().filter((m) => m.id < '008');
  const m008 = loadMigrations().find((m) => m.id === '008-duplicate-status');
  assert.ok(m008, '008 is loaded after the .sql migrations');

  const store = openStore(':memory:', { app: 'job-agent', migrations: before });
  const { db } = store;
  const add = (status, stage, notes) =>
    Number(
      db
        .prepare(`INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, stage, status, notes, created_at, updated_at)
          VALUES (?, 'Example Co', 'CTO', 'example|cto', '2026-10-01', ?, ?, ?, 'x', 'x')`)
        .run(`k${Math.random()}`, stage, status, notes).lastInsertRowid,
    );
  const history = (id, by) => db.prepare("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, 'new', 'passed', ?, 'x')").run(id, by);
  const applied = add('applied', 'pipeline', null);
  const cleanupCopy = add('passed', 'archived', 'Removed 2026-10-01: duplicate of #1, CTO at Example Co, pipeline/applied.');
  const userPassed = add('passed', 'archived', 'Removed 2026-10-01: duplicate of #1, CTO at Example Co, pipeline/applied.');
  history(cleanupCopy, 'agent');
  history(userPassed, 'user');
  db.prepare("INSERT INTO scores (posting_id, score, source, created_at) VALUES (?, 8, 'v2', 'x')").run(applied);
  db.prepare("INSERT INTO artifacts (posting_id, kind, content, source, created_at) VALUES (?, 'cover_letter', 'Body', 'v2', 'x')").run(applied);
  const indexes = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'postings' AND sql IS NOT NULL ORDER BY name").pluck().all();
  const indexesBefore = indexes();

  db.transaction(() => m008.up(db))();

  assert.equal(db.prepare('SELECT COUNT(*) FROM postings').pluck().get(), 3);
  assert.equal(db.prepare('SELECT COUNT(*) FROM scores WHERE posting_id = ?').pluck().get(applied), 1, 'scores survive');
  assert.equal(db.prepare('SELECT COUNT(*) FROM artifacts WHERE posting_id = ?').pluck().get(applied), 1, 'letters survive');
  assert.equal(db.prepare('SELECT status FROM postings WHERE id = ?').pluck().get(cleanupCopy), 'duplicate');
  assert.equal(db.prepare('SELECT status FROM postings WHERE id = ?').pluck().get(userPassed), 'passed', 'a pass the user made stays');
  assert.deepEqual(indexes(), indexesBefore);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'postings'").pluck().get(), /'duplicate'\)/);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'scores'").pluck().get(), /REFERENCES postings\(id\)/, 'children still point at postings');
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.throws(() => db.prepare("UPDATE postings SET status = 'maybe' WHERE id = ?").run(applied), /CHECK/, 'the constraint is still enforced');
  db.transaction(() => m008.up(db))();
  assert.equal(db.prepare('SELECT COUNT(*) FROM status_history WHERE to_status = ?').pluck().get('duplicate'), 1, 'running it again changes nothing');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.prepare('SELECT COUNT(*) FROM application_funnel').pluck().get(), 0, 'the funnel view still works');
  db.prepare('DELETE FROM postings WHERE id = ?').run(applied);
  assert.equal(db.prepare('SELECT COUNT(*) FROM scores').pluck().get(), 0, 'cascades still work after the rebuild');
  store.close();
});
