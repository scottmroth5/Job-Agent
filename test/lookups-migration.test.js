import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@scottmroth5/agent-core';
import { openJobStore, loadMigrations } from '../db/index.js';

// Synthetic data only.
const insert = (db, o = {}) =>
  db
    .prepare(`INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, stage, status, track, created_at, updated_at)
      VALUES (@k, 'Example Co', 'CTO', 'example|cto', '2026-10-01', @stage, @status, @track, 'x', 'x')`)
    .run({ k: `k${Math.random()}`, stage: 'discovered', status: 'new', track: 'fulltime', ...o });

test('009 seeds the built-in values in order, with groups, settings, and roles', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const ids = (list) => db.prepare('SELECT id FROM lookup_values WHERE list = ? ORDER BY sort_order').pluck().all(list);
  assert.deepEqual(ids('status'), ['new', 'applied', 'interviewing', 'offer', 'passed', 'closed', 'rejected', 'duplicate']);
  assert.deepEqual(ids('stage'), ['discovered', 'pipeline', 'archived']);
  assert.deepEqual(ids('track'), ['fulltime', 'fractional']);
  assert.equal(db.prepare("SELECT group_key FROM lookup_values WHERE list = 'status' AND id = 'offer'").pluck().get(), 'decision');
  assert.deepEqual(JSON.parse(db.prepare("SELECT settings_json FROM lookup_values WHERE id = 'fractional'").pluck().get()), { scorePrompt: 'score-fractional', terms: true });
  assert.deepEqual(db.prepare('SELECT list, role, value_id FROM lookup_roles ORDER BY list, role').all().map((r) => `${r.list}.${r.role}=${r.value_id}`), [
    'stage.archive=archived', 'stage.default=discovered', 'stage.promote=pipeline', 'status.default=new', 'track.default=fulltime',
  ]);
  store.close();
});

test('jobs accept any value in the lists, including new and archived ones, and nothing else', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  db.prepare("INSERT INTO lookup_values (list, id, label, group_key, sort_order, origin, created_at, updated_at) VALUES ('status', 'phone_screen', 'Phone screen', 'conversation', 25, 'custom', 'x', 'x')").run();
  const id = insert(db, { status: 'phone_screen' }).lastInsertRowid;
  db.prepare("UPDATE lookup_values SET archived_at = 'x' WHERE id = 'phone_screen'").run();
  db.prepare("UPDATE postings SET notes = 'still fine' WHERE id = ?").run(id);
  assert.throws(() => insert(db, { status: 'maybe' }), /status is not in the status list/);
  assert.throws(() => insert(db, { stage: 'limbo' }), /stage is not in the stage list/);
  assert.throws(() => insert(db, { track: 'parttime' }), /track is not in the track list/);
  assert.throws(() => db.prepare("UPDATE postings SET track = 'parttime' WHERE id = ?").run(id), /track is not in the track list/);
  assert.throws(() => db.prepare("DELETE FROM lookup_values WHERE id = 'phone_screen'").run(), /never deleted/);
  assert.throws(() => db.prepare("UPDATE lookup_values SET id = 'screen' WHERE id = 'phone_screen'").run(), /never changes/);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'postings'").pluck().get(), /CHECK \(workplace IN/, 'other CHECK constraints stay');
  store.close();
});

test('009 on an existing database keeps every row and refuses unknown values already in use', () => {
  const all = loadMigrations();
  const m009 = all.find((m) => m.id === '009-lookups');
  const store = openStore(':memory:', { app: 'job-agent', migrations: all.filter((m) => m.id < '009') });
  const { db } = store;
  const pid = insert(db, { status: 'duplicate', track: 'fractional', stage: 'archived' }).lastInsertRowid;
  db.prepare("INSERT INTO scores (posting_id, score, source, created_at) VALUES (?, 8, 'v2', 'x')").run(pid);
  db.transaction(() => m009.up(db))();
  assert.equal(db.prepare('SELECT COUNT(*) FROM scores').pluck().get(), 1);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  store.close();
});
