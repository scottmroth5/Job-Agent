// The SQLite engine behind db/engine/types.ts (v3 Phase 3): the async interface over the one better-sqlite3 connection.
//
// Scoping is db/scope.ts's, unchanged: a statement whose SQL names @uid gets the current user (runAsUser) or fallbackUid
// bound when it runs, and throws when there is neither.
//
// Transactions. better-sqlite3's are synchronous, so nothing could ever run inside one but its own statements. An async
// transaction awaits, and on one connection anything another request runs meanwhile would land inside it (and be rolled
// back with it). So: transactions take a mutex, one at a time; the open one's context travels in AsyncLocalStorage, and
// its own statements run at once; a statement from anywhere else waits until no transaction is open. A nested tx is a
// savepoint, one at a time within its transaction (a statement of the transaction run alongside an open savepoint, as
// in Promise.all, joins the savepoint; await a nested tx before going on).
//
// Transactions stay short: a transaction body may wait only on the database. Under node --test (strictTx) a body that
// lets a macrotask run (any network, Claude, Google, browser, file, or timer wait does) fails and rolls back, so the
// test suite finds a transaction that waits on anything else. In production the mutex keeps such a transaction correct;
// it would only hold everyone else up.
//
// While the synchronous interface still exists (store.db, and agent-core's synchronous tracer until 0.4.0), its
// statements do not wait: one made while an async transaction is open joins it. That needs a transaction body to wait on
// something outside the database, which the guard above keeps out.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database as Sqlite, Statement as SqliteStatement } from 'better-sqlite3';
import { bindUid, userIdOr } from '../scope.ts';
import { insidePgTransaction } from './context.ts';
import { returnsId } from './sql.ts';
import type { Db, RunResult, Statement } from './types.ts';

/** A first-come lock: lock() resolves to a release function once every earlier holder has released. */
class Mutex {
  #tail: Promise<void> = Promise.resolve();

  lock(): Promise<() => void> {
    const before = this.#tail;
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tail = before.then(() => mine);
    return before.then(() => release);
  }

  /** Settles once every holder so far has released. */
  idle(): Promise<void> {
    return this.#tail;
  }
}

/** The transaction this code runs in (top), whether it is still open, and the lock that keeps savepoints in it one at a time. */
interface TxContext {
  top: object;
  isOpen: () => boolean;
  savepoints: Mutex;
}

// One context for every engine, so assertOutsideTransaction sees a transaction from any of them.
const context = new AsyncLocalStorage<TxContext>();

/** True while the calling code runs inside an open transaction. */
export function insideTransaction(): boolean {
  return (context.getStore()?.isOpen() ?? false) || insidePgTransaction();
}

/**
 * Throws when called inside an open transaction. Claude and HTTP calls check it, since a transaction holds every other
 * database statement until it ends (step 5 of Phase 3: no network calls inside tx).
 */
export function assertOutsideTransaction(what: string): void {
  if (insideTransaction()) throw new Error(`${what} can not run inside a database transaction. Move it outside tx.`);
}

/**
 * Fails a transaction whose body let a macrotask run, so it waited on something besides the database. A setImmediate
 * and a 0 ms timer catch any timer wait and nearly every I/O wait; an I/O callback that lands within the same
 * millisecond, in the loop turn right after a transaction that began in the check phase, can slip past. So it is a
 * backstop: assertOutsideTransaction at the Claude and HTTP boundaries is the exact check.
 */
function macrotaskGuard() {
  let spanned = false;
  const mark = () => {
    spanned = true;
  };
  const immediate = setImmediate(mark);
  const timer = setTimeout(mark, 0);
  const stop = () => {
    clearImmediate(immediate);
    clearTimeout(timer);
  };
  return {
    check() {
      stop();
      if (spanned) {
        throw new Error('A database transaction waited on something besides the database (a network, file, or timer wait). Move that work outside tx.');
      }
    },
    stop,
  };
}

export interface SqliteEngineOptions {
  /** Who runs outside runAsUser: the owner for scripts and tests; null (the server) makes a @uid query there throw. */
  fallbackUid?: number | null;
  /** Fail a transaction that waits on something besides the database; on under node --test. */
  strictTx?: boolean;
}

/**
 * One connection's transaction state. Every engine over a connection shares it (engines differ only in fallbackUid),
 * so there is one lock and one open transaction per connection however many views of it exist.
 */
interface ConnectionState {
  transactions: Mutex;
  open: object | null;
  savepointCount: number;
}
const connections = new WeakMap<Sqlite, ConnectionState>();
function stateOf(raw: Sqlite): ConnectionState {
  let state = connections.get(raw);
  if (!state) {
    state = { transactions: new Mutex(), open: null, savepointCount: 0 };
    connections.set(raw, state);
  }
  return state;
}

/** The async Db over a better-sqlite3 connection (the unscoped one; scoping happens here). */
export function createSqliteEngine(raw: Sqlite, { fallbackUid = null, strictTx = process.env.NODE_TEST_CONTEXT !== undefined }: SqliteEngineOptions = {}): Db {
  const userId = userIdOr(fallbackUid);
  const state = stateOf(raw);
  const { transactions } = state;
  const contextFor = (top: object): TxContext => ({ top, isOpen: () => state.open === top, savepoints: new Mutex() });

  // A statement may run now when no transaction is open, or when it belongs to the open one.
  const mayRun = () => !raw.inTransaction || (state.open !== null && context.getStore()?.top === state.open);
  async function whenFree() {
    while (!mayRun()) await transactions.idle();
  }

  function statement<Row>(stmt: SqliteStatement, plucked: boolean): Statement<Row> {
    const withId = returnsId(stmt.source);
    // The check and the call run in one synchronous step, so no transaction can open between them.
    const exec = async <R>(call: (args: unknown[]) => R, args: unknown[]): Promise<R> => {
      if (!mayRun()) await whenFree();
      return call(bindUid(stmt.source, args, userId));
    };
    const read = () => {
      if (stmt.reader) stmt.pluck(plucked);
    };
    return {
      get: (...args) =>
        exec((b) => {
          read();
          return stmt.get(...b) as Row | undefined;
        }, args),
      all: (...args) =>
        exec((b) => {
          read();
          return stmt.all(...b) as Row[];
        }, args),
      run: (...args) =>
        exec((b): RunResult => {
          const r = stmt.run(...b);
          // Only RETURNING id reports the id, as on PostgreSQL, so a missing RETURNING fails here too.
          if (withId) return { changes: r.changes, id: Number(r.lastInsertRowid) };
          return Object.defineProperty({ changes: r.changes }, 'id', { enumerable: false, get: noId });
        }, args),
      pluck: <Value>() => statement<Value>(stmt, true),
    };
  }

  async function savepoint<T>(ctx: TxContext, fn: () => Promise<T>): Promise<T> {
    const release = await ctx.savepoints.lock();
    state.savepointCount += 1;
    const name = `sp${state.savepointCount}`;
    raw.exec(`SAVEPOINT ${name}`);
    try {
      const result = await context.run(contextFor(ctx.top), fn);
      raw.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      raw.exec(`ROLLBACK TO ${name}`);
      raw.exec(`RELEASE ${name}`);
      throw err;
    } finally {
      release();
    }
  }

  async function tx<T>(fn: () => Promise<T>): Promise<T> {
    const ctx = context.getStore();
    if (ctx && state.open !== null && ctx.top === state.open) return savepoint(ctx, fn);
    const release = await transactions.lock();
    try {
      // A synchronous statement can not be mid-transaction here: better-sqlite3's transactions finish in one step.
      const top = {};
      raw.exec('BEGIN IMMEDIATE');
      state.open = top;
      const guard = strictTx ? macrotaskGuard() : null;
      try {
        const result = await context.run(contextFor(top), fn);
        guard?.check();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        guard?.stop();
        if (raw.inTransaction) raw.exec('ROLLBACK');
        throw err;
      } finally {
        state.open = null;
      }
    } finally {
      release();
    }
  }

  const engine: Db = {
    dialect: 'sqlite',
    prepare: <Row>(sql: string) => statement<Row>(raw.prepare(sql), false),
    tx,
  };
  connectionOfEngine.set(engine, raw);
  return engine;
}

const connectionOfEngine = new WeakMap<Db, Sqlite>();

// Reading id from a statement without RETURNING id is a bug on every engine (PostgreSQL has no last insert id), so it
// throws here rather than quietly working on SQLite only.
function noId(): never {
  throw new Error('run().id needs the statement to end in RETURNING id');
}

/** The connection under an engine made here (for caches of app-wide data, shared by every view of it). */
export const connectionOf = (db: Db): Sqlite | undefined => connectionOfEngine.get(db);
