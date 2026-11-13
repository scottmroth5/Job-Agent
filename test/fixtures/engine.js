// Tests run on SQLite (npm test) and on PostgreSQL (npm run test:pg, v3 Phase 4). These read the database's own facts
// (tables, columns, keys) and its error wording the same way on both, and name the tests that only make sense on SQLite.
import { postgresUrl } from '../../db/index.ts';
/** @import { Db } from '../../tools/types.ts' */

/** True when this run's stores are on PostgreSQL. */
export const onPostgres = Boolean(postgresUrl());

/**
 * For test options: skips a test of something only SQLite has (its old migrations, its file copies and backups, its
 * catalog), with the reason. Every use is listed in test/engine-skips.test.js.
 * @param {string} why
 */
export const sqliteOnly = (why) => (onPostgres ? `SQLite only: ${why}` : false);

/** A unique-constraint failure, in either engine's words. */
export const UNIQUE_FAILED = /UNIQUE constraint failed|violates unique constraint/;
/** A CHECK failure, in either engine's words. */
export const CHECK_FAILED = /CHECK constraint failed|violates check constraint/;
/** A NOT NULL failure, in either engine's words. */
export const NOT_NULL_FAILED = /NOT NULL constraint failed|violates not-null constraint/;

/** The tables in the store's schema (app and agent-core tables, without the engine's own). @param {Db} db */
export async function tablesOf(db) {
  const sql = db.dialect === 'postgres'
    ? "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name"
    : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
  return /** @type {string[]} */ (await db.prepare(sql).pluck().all());
}

/** A table's column names, in table order. @param {Db} db @param {string} table */
export async function columnsOf(db, table) {
  const sql = db.dialect === 'postgres'
    ? 'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position'
    : 'SELECT name FROM pragma_table_info(?) ORDER BY cid';
  return /** @type {string[]} */ (await db.prepare(sql).pluck().all(table));
}

/** A table's primary key columns, in key order. @param {Db} db @param {string} table */
export async function primaryKeyOf(db, table) {
  const sql = db.dialect === 'postgres'
    ? `SELECT a.attname FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = (quote_ident(current_schema()) || '.' || quote_ident(?))::regclass AND i.indisprimary
        ORDER BY array_position(i.indkey::int2[], a.attnum)`
    : 'SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk';
  return /** @type {string[]} */ (await db.prepare(sql).pluck().all(table));
}

/** A foreign key failure, in either engine's words. */
export const FOREIGN_KEY_FAILED = /FOREIGN KEY constraint failed|violates foreign key constraint/;
