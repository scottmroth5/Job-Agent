// The PostgreSQL schema (db/postgres) and SQLite's (db/migrations) stay the same (v3 Phase 4): the same tables,
// columns, types, nullability, primary keys, and indexes. Every SQLite migration after the baseline has a PostgreSQL
// file of the same name, and nothing else is there. The comparison needs PostgreSQL, so it runs under npm run test:pg
// (and CI's PostgreSQL job); the file-name check runs everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@scottmroth5/agent-core';
import { loadMigrations, openJobStore } from '../db/index.ts';
import { createSqliteEngine } from '../db/engine/sqlite.ts';
import { BASELINE_THROUGH, laterMigrations } from '../db/postgres/store.ts';
import { onPostgres, primaryKeyOf } from './fixtures/engine.js';
/** @import { Db } from '../tools/types.ts' */

test('every SQLite migration after the baseline has a PostgreSQL file of the same name, and only those', () => {
  const after = loadMigrations().map((m) => m.id).filter((id) => id > BASELINE_THROUGH);
  assert.deepEqual(laterMigrations().map((m) => m.id), after);
});

// SQLite's declared type, as PostgreSQL spells it here (INTEGER may be bigint where counts can grow).
/** @type {Record<string, string[]>} */
const SAME_TYPE = { INTEGER: ['integer', 'bigint'], TEXT: ['text'], REAL: ['double precision'], BLOB: ['bytea'] };

/** @param {Db} db */
async function sqliteShape(db) {
  const tables = /** @type {string[]} */ (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all());
  /** @type {Record<string, unknown>} */
  const shape = {};
  for (const t of tables) {
    const cols = /** @type {Array<{ name: string, type: string, notnull: number, pk: number }>} */ (await db.prepare('SELECT name, type, "notnull", pk FROM pragma_table_info(?) ORDER BY name').all(t));
    const indexes = /** @type {Array<{ name: string, unique: number, origin: string }>} */ (await db.prepare('SELECT name, "unique", origin FROM pragma_index_list(?)').all(t))
      .filter((i) => i.origin === 'c') // made by CREATE INDEX (not by a PRIMARY KEY or UNIQUE in the table)
      .map((i) => `${i.name}${i.unique ? ' unique' : ''}`)
      .sort();
    shape[t] = {
      // Required: NOT NULL, or part of the primary key (PostgreSQL makes key columns NOT NULL; SQLite's never hold NULL here).
      columns: cols.map((c) => ({ name: c.name, type: c.type.toUpperCase(), required: Boolean(c.notnull) || c.pk > 0 })),
      key: /** @type {string[]} */ (await primaryKeyOf(db, t)),
      indexes,
    };
  }
  return shape;
}

/** @param {Db} db */
async function postgresShape(db) {
  const tables = /** @type {string[]} */ (await db.prepare("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name").pluck().all());
  /** @type {Record<string, unknown>} */
  const shape = {};
  for (const t of tables) {
    const cols = /** @type {Array<{ name: string, type: string, nullable: string }>} */ (await db.prepare(`SELECT column_name AS name, data_type AS type, is_nullable AS nullable
      FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY column_name`).all(t));
    const indexes = /** @type {Array<{ name: string, isunique: number }>} */ (await db.prepare(`SELECT c.relname AS name, i.indisunique AS isunique FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = (quote_ident(current_schema()) || '.' || quote_ident(?))::regclass AND NOT i.indisprimary
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)`).all(t))
      .map((i) => `${i.name}${i.isunique ? ' unique' : ''}`)
      .sort();
    shape[t] = { columns: cols, key: await primaryKeyOf(db, t), indexes };
  }
  return shape;
}

test('PostgreSQL has the same tables, columns, types, nullability, keys, and indexes as SQLite', { skip: onPostgres ? false : 'runs under npm run test:pg' }, async () => {
  const sqlite = openStore(':memory:', { app: 'job-agent', migrations: loadMigrations() });
  const lite = /** @type {Record<string, { columns: Array<{ name: string, type: string, required: boolean }>, key: string[], indexes: string[] }>} */ (await sqliteShape(createSqliteEngine(sqlite.db, { fallbackUid: null, strictTx: false })));
  sqlite.close();
  const store = openJobStore(':memory:');
  await store.ready;
  const pg = /** @type {Record<string, { columns: Array<{ name: string, type: string, nullable: string }>, key: string[], indexes: string[] }>} */ (await postgresShape(store.admin));
  store.close();

  assert.deepEqual(Object.keys(pg).sort(), Object.keys(lite).sort(), 'the same tables');
  for (const [table, l] of Object.entries(lite)) {
    const p = pg[table];
    assert.deepEqual(p.columns.map((c) => c.name), l.columns.map((c) => c.name), `${table}: the same columns`);
    for (const c of l.columns) {
      const pc = /** @type {{ type: string, nullable: string }} */ (p.columns.find((x) => x.name === c.name));
      assert.ok((SAME_TYPE[c.type] ?? []).includes(pc.type), `${table}.${c.name}: ${c.type} on SQLite, ${pc.type} on PostgreSQL`);
      assert.equal(pc.nullable === 'NO', c.required, `${table}.${c.name}: ${c.required ? 'required' : 'optional'} on SQLite`);
    }
    assert.deepEqual(p.key, l.key, `${table}: the same primary key`);
    assert.deepEqual(p.indexes, l.indexes, `${table}: the same indexes`);
  }
});
