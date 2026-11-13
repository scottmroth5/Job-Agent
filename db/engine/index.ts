// What the engine's callers share beyond the Db interface (db/engine/types.ts).
import { engineKeys } from './context.ts';
import { connectionOf } from './sqlite.ts';
import type { Db } from './types.ts';

/** One key per connection, whichever engine over it db is: for caches of app-wide data (the lists) that every view shares. */
export function connectionKey(db: Db): object {
  return connectionOf(db) ?? engineKeys.get(db) ?? db;
}
