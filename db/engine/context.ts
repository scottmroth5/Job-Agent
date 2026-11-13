// What both engines share without loading each other (v3 Phase 4): the PostgreSQL engine's transaction context, so
// insideTransaction() (db/engine/sqlite.ts, which Claude and HTTP calls check) sees a transaction on either engine, and
// each engine's connection key for caches of app-wide data (db/engine/index.ts connectionKey).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from './types.ts';

/** An open PostgreSQL transaction: the client it runs on, for the pool it came from. */
export interface PgTxContext {
  pool: object;
  client: { query: (...args: never[]) => unknown };
  open: boolean;
}

export const pgTransaction = new AsyncLocalStorage<PgTxContext>();

export const insidePgTransaction = (): boolean => pgTransaction.getStore()?.open ?? false;

/** Each non-SQLite engine's connection key (its pool), registered by the engine. */
export const engineKeys = new WeakMap<Db, object>();
