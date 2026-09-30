import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';

const now = '2026-01-01T00:00:00.000Z';

function insertPosting(db, overrides = {}) {
  const row = {
    url: 'https://example.com/jobs/1',
    url_key: 'example.com/jobs/1',
    company: 'Acme',
    title: 'VP Engineering',
    company_title_key: 'acme|vp engineering',
    discovered_on: '2026-01-01',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  const cols = Object.keys(row);
  return db
    .prepare(`INSERT INTO postings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...Object.values(row)).lastInsertRowid;
}

test('creates the app tables next to the agent-core tables', () => {
  const store = openJobStore(':memory:');
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
  for (const t of ['postings', 'scores', 'artifacts', 'status_history', 'runs', 'run_calls']) assert.ok(tables.includes(t), t);
  store.close();
});

test('defaults new postings to discovered/new and enforces allowed values', () => {
  const store = openJobStore(':memory:');
  const id = insertPosting(store.db);
  assert.deepEqual(store.db.prepare('SELECT stage, status FROM postings WHERE id = ?').get(id), { stage: 'discovered', status: 'new' });
  assert.throws(() => insertPosting(store.db, { url_key: 'k2', stage: 'somewhere' }), /CHECK/);
  assert.throws(() => insertPosting(store.db, { url_key: 'k3', status: 'maybe' }), /CHECK/);
  assert.throws(() => insertPosting(store.db), /UNIQUE/);
  store.close();
});

test('scores must be 1 to 10 and follow their posting on delete', () => {
  const store = openJobStore(':memory:');
  const id = insertPosting(store.db);
  const addScore = (score) =>
    store.db.prepare("INSERT INTO scores (posting_id, score, source, created_at) VALUES (?, ?, 'v2', ?)").run(id, score, now);
  addScore(8);
  assert.throws(() => addScore(11), /CHECK/);
  store.db.prepare('DELETE FROM postings WHERE id = ?').run(id);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM scores').pluck().get(), 0);
  store.close();
});
