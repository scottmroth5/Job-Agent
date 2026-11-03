// The one way to start a traced run in this app: agent-core's tracer, with each run stamped with the user it runs as
// (db/scope.ts), so run history and Claude spend are per user. agent-core writes the runs row; the stamp follows at
// once, before any Claude call can be recorded against it.
import { createTracer } from '@scottmroth5/agent-core';
import type { Run } from '@scottmroth5/agent-core';
import type { Database, Logger } from './types.ts';

/** createTracer's API; startRun also records runs.user_id. */
export function createJobTracer({ store, logger }: { store?: { db: Database } | null; logger?: Logger | null } = {}) {
  const tracer = createTracer({ ...(store ? { store } : {}), ...(logger ? { logger } : {}) });
  return {
    startRun(name: string, meta?: object): Run {
      const run = tracer.startRun(name, meta);
      if (store && run.id != null) store.db.prepare('UPDATE runs SET user_id = @uid WHERE id = ? AND user_id IS NULL').run(run.id);
      return run;
    },
  };
}
