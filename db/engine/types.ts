// The data layer's one interface (v3 Phase 3): every database call is asynchronous and goes through Db, so the engine
// underneath can change (SQLite now, PostgreSQL in Phase 4) without touching callers. db/engine/sqlite.ts is the SQLite
// engine. Type-only: nothing here exists at run time.

/** What a write reports: rows changed, and the new row's id for an insert (SQLite's lastInsertRowid). */
export interface RunResult {
  changes: number;
  id?: number;
}

/**
 * A prepared statement. Bind values are positional (?) or one object of named values (@name); @uid is bound to the
 * current user (db/scope.ts runAsUser) and must not be passed.
 */
export interface Statement<Row = unknown> {
  get(...params: unknown[]): Promise<Row | undefined>;
  all(...params: unknown[]): Promise<Row[]>;
  run(...params: unknown[]): Promise<RunResult>;
  /** Rows as their first column's value (SQLite's pluck). */
  pluck<Value = unknown>(): Statement<Value>;
}

export interface Db {
  prepare<Row = unknown>(sql: string): Statement<Row>;
  /**
   * Runs fn in a transaction: committed when fn resolves, rolled back when it rejects. Transactions are serialized,
   * and statements from outside wait while one is open, so nothing else lands inside it. Inside a transaction a nested
   * tx is a savepoint. fn must only wait on the database: no Claude, Google, browser, or timer waits (tests enforce it).
   */
  tx<T>(fn: () => Promise<T>): Promise<T>;
}
