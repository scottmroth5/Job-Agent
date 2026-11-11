// Types shared across the app (v3 Phase 2). Type-only: nothing here exists at run time.
import type { Database } from 'better-sqlite3';
import type { Store } from '@scottmroth5/agent-core';
import type { Db } from '../db/engine/types.ts';

export type { Database, Db };

/** openJobStore's result (db/index.ts): db is scoped to the current user (db/scope.ts), raw is not; engine is async. */
export interface JobStore extends Store {
  raw: Database;
  engine: Db;
}

/** The logging a module needs: console fits, and so does a task's logger (server/tasks.ts). */
export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /** console and a task's logger have it too; quiet loggers pass one so they fit both. */
  log?: (...args: unknown[]) => void;
}
