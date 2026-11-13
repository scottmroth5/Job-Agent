import { test } from 'node:test';
import { createSqliteEngine } from '../db/engine/sqlite.ts';
import assert from 'node:assert/strict';
import { openStore } from '@scottmroth5/agent-core';
import { openJobStore, loadMigrations } from '../db/index.ts';
import { CHECK_FAILED, columnsOf } from './fixtures/engine.js';
/** @import { Db } from '../tools/types.ts' */

/** A code migration's up function (these migrations are code, not SQL). */
const upOf = (/** @type {string} */ id) => /** @type {(db: import('better-sqlite3').Database) => void} */ (loadMigrations().find((x) => x.id === id)?.up);

// Synthetic data only.
// Used before 013 (no user_id yet) and after it (the owner's job).
const hasUser = async (/** @type {Db} */ db) => (await columnsOf(db, 'postings')).includes('user_id');
const insert = async (/** @type {Db} */ db, /** @type {Record<string, string>} */ o = {}) =>
  await db
    .prepare(`INSERT INTO postings (${await hasUser(db) ? 'user_id, ' : ''}url_key, company, title, company_title_key, discovered_on, stage, status, track, created_at, updated_at)
      VALUES (${await hasUser(db) ? '1, ' : ''}@k, 'Example Co', 'CTO', 'example|cto', '2026-10-01', @stage, @status, @track, 'x', 'x') RETURNING id`)
    .run({ k: `k${Math.random()}`, stage: 'discovered', status: 'new', track: 'fulltime', ...o });

test('009, 018, and 023 seed the built-in values in order, with groups, settings, and roles', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const ids = async (/** @type {string} */ list) => await db.prepare('SELECT id FROM lookup_values WHERE list = ? ORDER BY sort_order').pluck().all(list);
  assert.deepEqual(await ids('status'), ['new', 'applied', 'interviewing', 'offer', 'passed', 'closed', 'rejected', 'no_response', 'duplicate']);
  assert.deepEqual(await ids('stage'), ['discovered', 'pipeline', 'archived']);
  assert.deepEqual(await ids('track'), ['fulltime', 'fractional']);
  assert.equal(await db.prepare("SELECT group_key FROM lookup_values WHERE list = 'status' AND id = 'offer'").pluck().get(), 'decision');
  assert.deepEqual(JSON.parse(/** @type {string} */ (await db.prepare("SELECT settings_json FROM lookup_values WHERE id = 'fractional'").pluck().get())), { scorePrompt: 'score-fractional', terms: true });
  assert.deepEqual(/** @type {Array<{ list: string, role: string, value_id: string }>} */ (await db.prepare('SELECT list, role, value_id FROM lookup_roles ORDER BY list, role').all()).map((r) => `${r.list}.${r.role}=${r.value_id}`), [
    'stage.archive=archived', 'stage.default=discovered', 'stage.promote=pipeline',
    'status.applied=applied', 'status.default=new', 'status.duplicate=duplicate', 'status.interview=interviewing', 'status.noResponse=no_response',
    'status.offer=offer', 'status.passed=passed', 'status.rejected=rejected', 'track.default=fulltime',
  ]);
  store.close();
});

test('023 keeps a status role already set and fills in the rest', async () => {
  // Every migration, on a connection the test can hand to 023 again.
  const store = openStore(':memory:', { app: 'job-agent', migrations: loadMigrations() });
  const conn = store.db;
  const raw = createSqliteEngine(conn, { fallbackUid: null, strictTx: false });
  await raw.prepare("DELETE FROM lookup_roles WHERE list = 'status' AND role IN ('applied', 'interview', 'offer', 'rejected', 'duplicate', 'passed')").run();
  await raw.prepare("INSERT INTO lookup_values (list, id, label, group_key, sort_order, origin, created_at, updated_at) VALUES ('status', 'turned_down', 'Turned down', 'closed', 999, 'custom', 'x', 'x')").run();
  await raw.prepare("INSERT INTO lookup_roles (list, role, value_id) VALUES ('status', 'rejected', 'turned_down')").run();
  upOf('023-status-roles')(conn);
  const roles = Object.fromEntries(/** @type {Array<{ role: string, value_id: string }>} */ (await raw.prepare("SELECT role, value_id FROM lookup_roles WHERE list = 'status'").all()).map((r) => [r.role, r.value_id]));
  assert.equal(roles.rejected, 'turned_down', 'kept');
  assert.equal(roles.duplicate, 'duplicate');
  assert.deepEqual([roles.applied, roles.interview, roles.offer, roles.passed], ['applied', 'interviewing', 'offer', 'passed']);
  store.close();
});

test('jobs accept any value in the lists, including new and archived ones, and nothing else', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  await db.prepare("INSERT INTO lookup_values (list, id, label, group_key, sort_order, origin, created_at, updated_at) VALUES ('status', 'phone_screen', 'Phone screen', 'conversation', 25, 'custom', 'x', 'x')").run();
  const id = (await insert(db, { status: 'phone_screen' })).id;
  await db.prepare("UPDATE lookup_values SET archived_at = 'x' WHERE id = 'phone_screen'").run();
  await db.prepare("UPDATE postings SET notes = 'still fine' WHERE id = ?").run(id);
  await assert.rejects(async () => await insert(db, { status: 'maybe' }), /status is not in the status list/);
  await assert.rejects(async () => await insert(db, { stage: 'limbo' }), /stage is not in the stage list/);
  await assert.rejects(async () => await insert(db, { track: 'parttime' }), /track is not in the track list/);
  await assert.rejects(async () => await db.prepare("UPDATE postings SET track = 'parttime' WHERE id = ?").run(id), /track is not in the track list/);
  await assert.rejects(async () => await db.prepare("DELETE FROM lookup_values WHERE id = 'phone_screen'").run(), /never deleted/);
  await assert.rejects(async () => await db.prepare("UPDATE lookup_values SET id = 'screen' WHERE id = 'phone_screen'").run(), /never changes/);
  await assert.rejects(async () => await db.prepare("UPDATE postings SET workplace = 'moon' WHERE id = ?").run(id), CHECK_FAILED, 'other CHECK constraints stay');
  store.close();
});

test('009 on an existing database keeps every row and refuses unknown values already in use', async () => {
  const all = loadMigrations();
  const m009 = all.find((m) => m.id === '009-lookups');
  const store = openStore(':memory:', { app: 'job-agent', migrations: all.filter((m) => m.id < '009') });
  const conn = store.db;
  const db = createSqliteEngine(conn, { fallbackUid: null, strictTx: false });
  const pid = (await insert(db, { status: 'duplicate', track: 'fractional', stage: 'archived' })).id;
  await db.prepare("INSERT INTO scores (posting_id, score, source, created_at) VALUES (?, 8, 'v2', 'x')").run(pid);
  const up = /** @type {(db: import('better-sqlite3').Database) => void} */ (m009?.up);
  conn.transaction(() => up(conn))();
  assert.equal(await db.prepare('SELECT COUNT(*) FROM scores').pluck().get(), 1);
  assert.equal(conn.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(conn.pragma('foreign_key_check'), []);
  store.close();
});

test('023 gives no role to a value the list does not have', async () => {
  const { default: Db } = await import('better-sqlite3');
  const conn = new Db(':memory:');
  const raw = createSqliteEngine(conn, { fallbackUid: null, strictTx: false });
  conn.exec(`CREATE TABLE lookup_values (list TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (list, id));
    CREATE TABLE lookup_roles (list TEXT NOT NULL, role TEXT NOT NULL, value_id TEXT NOT NULL, PRIMARY KEY (list, role));`);
  for (const id of ['applied', 'interviewing', 'offer', 'rejected', 'passed']) await raw.prepare("INSERT INTO lookup_values (list, id) VALUES ('status', ?)").run(id);
  upOf('023-status-roles')(conn);
  assert.deepEqual(await raw.prepare("SELECT role FROM lookup_roles ORDER BY role").pluck().all(), ['applied', 'interview', 'offer', 'passed', 'rejected']);
  conn.close();
});
