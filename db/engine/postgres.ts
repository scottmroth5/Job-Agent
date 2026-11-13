// The PostgreSQL engine (v3 Phase 4): the same Db as db/engine/sqlite.ts, on a node-postgres pool.
//
// - SQL is the app's portable SQL (test/portable-sql.test.js): ? and @name placeholders become $n (db/engine/sql.ts),
//   with @uid bound from the current user (db/scope.ts) exactly as on SQLite.
// - Rows read the same on both engines: bigint (COUNT, SUM over integers) and numeric become numbers (a bigint past
//   Number.MAX_SAFE_INTEGER throws rather than lose digits), and booleans (EXISTS, IS NOT NULL) become 1 and 0, so
//   db/types.ts, generated from SQLite, stays true.
// - run() reports changes, and id only for a statement that ends in RETURNING id (on SQLite too).
// - tx(fn) runs fn on one client in BEGIN ... COMMIT, its client kept in AsyncLocalStorage so every statement inside
//   uses it; a nested tx is a savepoint. Each transaction first takes a transaction-scoped advisory lock for its schema,
//   so transactions run one at a time across every process on the database, as SQLite's BEGIN IMMEDIATE did. Phase 3's
//   read-then-write guarantees rest on that. Statements outside a transaction do not wait: PostgreSQL never shows them
//   uncommitted rows.
// - SQLite fails a transaction that waits on a timer under test (strictTx). That check cannot work here, where every
//   query is a real network wait; Claude and HTTP calls still refuse to run inside a transaction (insideTransaction).
import pg from 'pg';
import { bindUid, userIdOr } from '../scope.ts';
import { engineKeys, pgTransaction, type PgTxContext } from './context.ts';
import { bindValues, numberPlaceholders, returnsId, type Slot } from './sql.ts';
import type { Db, RunResult, Statement } from './types.ts';

const INT8 = 20;
const NUMERIC = 1700;
const BOOL = 16;

function int8(text: string): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new RangeError(`a bigint result (${text}) is too large to read as a number`);
  return n;
}

/** Row values as the SQLite engine returns them (see the header). */
export const TYPES = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8) return int8;
    if (oid === NUMERIC) return (text: string) => Number(text);
    if (oid === BOOL) return (text: string) => (text === 't' ? 1 : 0);
    return pg.types.getTypeParser(oid, format ?? 'text');
  },
};

/** A first-come lock for a transaction's savepoints (one at a time, as on SQLite). */
class Mutex {
  private last: Promise<void> = Promise.resolve();
  lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const turn = this.last.then(() => release);
    this.last = this.last.then(() => next);
    return turn;
  }
}

/** One transaction, shared by every level of it. */
interface TopTx {
  open: boolean;
  count: number;
}

/**
 * The context code inside a transaction runs in. Each savepoint's body gets a context of its own with a fresh lock, as
 * on SQLite: savepoints at one level take turns, and one inside another can open while its parent is still running.
 */
interface TxState extends PgTxContext {
  client: pg.PoolClient;
  top: TopTx;
  savepoints: Mutex;
}

const levelOf = (pool: pg.Pool, client: pg.PoolClient, top: TopTx): TxState => ({
  pool,
  client,
  top,
  savepoints: new Mutex(),
  get open() {
    return top.open;
  },
});

export interface PgEngineOptions {
  /** As on SQLite: the user for @uid outside runAsUser, or null to require one. */
  fallbackUid?: number | null;
  /** Waited on before every statement: the store's connect-and-migrate step. */
  ready?: Promise<unknown>;
}

/** A Db over a pool. Every engine over one pool shares its transactions (the store's db and admin, as on SQLite). */
export function createPgEngine(pool: pg.Pool, { fallbackUid = null, ready = Promise.resolve() }: PgEngineOptions = {}): Db {
  const prepared = new Map<string, { text: string; slots: Slot[] }>();
  const translate = (sql: string) => {
    let t = prepared.get(sql);
    if (!t) {
      t = numberPlaceholders(sql);
      prepared.set(sql, t);
    }
    return t;
  };

  const current = (): TxState | null => {
    const ctx = pgTransaction.getStore() as TxState | undefined;
    return ctx && ctx.open && ctx.pool === pool ? ctx : null;
  };

  async function query(sql: string, args: unknown[], rowMode?: 'array') {
    await ready;
    const { text, slots } = translate(sql);
    const values = bindValues(slots, bindUid(sql, args, userIdOr(fallbackUid)) as unknown[]);
    const runner = current()?.client ?? pool;
    return runner.query({ text, values, ...(rowMode ? { rowMode } : {}) });
  }

  function statement<Row>(sql: string, plucked: boolean): Statement<Row> {
    const withId = returnsId(sql);
    return {
      async get(...args) {
        const r = await query(sql, args, plucked ? 'array' : undefined);
        const row = r.rows[0];
        return (plucked ? (row as unknown[] | undefined)?.[0] : row) as Row | undefined;
      },
      async all(...args) {
        const r = await query(sql, args, plucked ? 'array' : undefined);
        return (plucked ? r.rows.map((row) => (row as unknown[])[0]) : r.rows) as Row[];
      },
      async run(...args): Promise<RunResult> {
        const r = await query(sql, args);
        const changes = r.rowCount ?? 0;
        if (withId) return { changes, id: Number((r.rows[0] as { id?: unknown } | undefined)?.id) };
        return Object.defineProperty({ changes }, 'id', { enumerable: false, get: noId });
      },
      pluck: <Value>() => statement<Value>(sql, true),
    };
  }

  async function savepoint<T>(ctx: TxState, fn: () => Promise<T>): Promise<T> {
    const release = await ctx.savepoints.lock();
    ctx.top.count += 1;
    const name = `sp${ctx.top.count}`;
    try {
      await ctx.client.query(`SAVEPOINT ${name}`);
      try {
        const result = await pgTransaction.run(levelOf(pool, ctx.client, ctx.top), fn);
        await ctx.client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        await ctx.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await ctx.client.query(`RELEASE SAVEPOINT ${name}`);
        throw err;
      }
    } finally {
      release();
    }
  }

  async function tx<T>(fn: () => Promise<T>): Promise<T> {
    await ready;
    const open = current();
    if (open) return savepoint(open, fn);
    const client = await pool.connect();
    const top: TopTx = { open: false, count: 0 };
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()))');
      top.open = true;
      const result = await pgTransaction.run(levelOf(pool, client, top), fn);
      top.open = false;
      await client.query('COMMIT');
      return result;
    } catch (err) {
      top.open = false;
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const engine: Db = { dialect: 'postgres', prepare: <Row>(sql: string) => statement<Row>(sql, false), tx };
  engineKeys.set(engine, pool);
  return engine;
}

function noId(): never {
  throw new Error('run().id needs the statement to end in RETURNING id');
}
