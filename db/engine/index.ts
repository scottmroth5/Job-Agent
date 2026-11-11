// While Phase 3 converts the app file by file, converted functions take AnyDb: the async engine, or one of the
// synchronous handles callers still hold (store.db, scoped; store.raw, unscoped). asEngine turns any of them into the
// engine over the same connection, scoped the same way. Every engine over a connection shares its transaction lock
// (db/engine/sqlite.ts), so these views are safe together. The last Phase 3 step narrows AnyDb to Db and removes this.
import type { Database } from 'better-sqlite3';
import type { ScopedDatabase } from '../scope.ts';
import { createSqliteEngine } from './sqlite.ts';
import type { Db } from './types.ts';

export type AnyDb = Db | Database | ScopedDatabase;

const views = new WeakMap<object, Db>();

const isSync = (db: AnyDb): db is Database | ScopedDatabase => typeof (db as Partial<Database>).pragma === 'function';

/** The async engine for db: itself when it is one; else the engine over its connection, scoped as it is. */
export function asEngine(db: AnyDb): Db {
  if (!isSync(db)) return db;
  let engine = views.get(db);
  if (!engine) {
    const scoped = db as Partial<ScopedDatabase>;
    // A scoped database keeps its fallback user; the unscoped one has none, as store.raw's callers never name @uid.
    engine = scoped.unscoped ? createSqliteEngine(scoped.unscoped, { fallbackUid: scoped.fallbackUid ?? null }) : createSqliteEngine(db, { fallbackUid: null });
    views.set(db, engine);
  }
  return engine;
}
