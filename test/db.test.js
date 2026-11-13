import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { tablesOf, UNIQUE_FAILED, CHECK_FAILED } from './fixtures/engine.js';
/** @import { Db } from '../tools/types.ts' */

const now = '2026-01-01T00:00:00.000Z';

/** @param {Db} db @param {Record<string, string>} [overrides] */
async function insertPosting(db, overrides = {}) {
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
  return (await db
    .prepare(`INSERT INTO postings (user_id, ${cols.join(', ')}) VALUES (1, ${cols.map(() => '?').join(', ')}) RETURNING id`)
    .run(...Object.values(row))).id;
}

test('creates the app tables next to the agent-core tables', async () => {
  const store = openJobStore(':memory:');
  const tables = await tablesOf(store.db);
  for (const t of ['postings', 'scores', 'artifacts', 'status_history', 'runs', 'run_calls']) assert.ok(tables.includes(t), t);
  store.close();
});

test('defaults new postings to discovered/new and enforces allowed values', async () => {
  const store = openJobStore(':memory:');
  const id = await insertPosting(store.db);
  assert.deepEqual(await store.db.prepare('SELECT stage, status FROM postings WHERE id = ?').get(id), { stage: 'discovered', status: 'new' });
  await assert.rejects(async () => await insertPosting(store.db, { url_key: 'k2', stage: 'somewhere' }), /stage is not in the stage list/);
  await assert.rejects(async () => await insertPosting(store.db, { url_key: 'k3', status: 'maybe' }), /status is not in the status list/);
  await assert.rejects(async () => await insertPosting(store.db), UNIQUE_FAILED);
  store.close();
});

test('scores must be 1 to 10 and follow their posting on delete', async () => {
  const store = openJobStore(':memory:');
  const id = await insertPosting(store.db);
  const addScore = async (/** @type {number} */ score) =>
    await store.db.prepare("INSERT INTO scores (user_id, posting_id, score, source, created_at) VALUES (1, ?, ?, 'v2', ?)").run(id, score, now);
  await addScore(8);
  await assert.rejects(async () => await addScore(11), CHECK_FAILED);
  await store.db.prepare('DELETE FROM postings WHERE id = ?').run(id);
  assert.equal(await store.db.prepare('SELECT COUNT(*) FROM scores').pluck().get(), 0);
  store.close();
});
