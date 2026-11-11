// The one way to start a traced run in this app: agent-core's tracer, with each run stamped with the user it runs as
// (db/scope.ts), so run history and Claude spend are per user. agent-core writes the runs row; the stamp follows at
// once, before any Claude call can be recorded against it. Every trace write goes through the async engine (db/engine),
// so it waits its turn behind an open transaction like any other statement.
import { createTracer } from '@scottmroth5/agent-core';
import type { Run } from '@scottmroth5/agent-core';
import type { Db } from '../db/engine/types.ts';
import type { Logger } from './types.ts';

/** createTracer's API; startRun also records runs.user_id. */
export function createJobTracer({ store, logger }: { store?: { db: Db } | null; logger?: Logger | null } = {}) {
  const db = store ? store.db : null;
  const tracer = createTracer({ ...(db ? { store: { db } } : {}), ...(logger ? { logger } : {}) });
  return {
    async startRun(name: string, meta?: object): Promise<Run> {
      const run = await tracer.startRun(name, meta);
      if (db && run.id != null) await db.prepare('UPDATE runs SET user_id = @uid WHERE id = ? AND user_id IS NULL').run(run.id);
      return run;
    },
  };
}
