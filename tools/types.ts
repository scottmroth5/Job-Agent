// Types shared across the app (v3 Phase 2). Type-only: nothing here exists at run time.
import type { Db } from '../db/engine/types.ts';
import type { JobStore } from '../db/index.ts';

// The database is the async engine (db/engine); openJobStore's store is db/index.ts JobStore.
export type { Db, JobStore };

/** The logging a module needs: console fits, and so does a task's logger (server/tasks.ts). */
export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /** console and a task's logger have it too; quiet loggers pass one so they fit both. */
  log?: (...args: unknown[]) => void;
}
