// The one way to start a traced run in this app: agent-core's tracer with this app's sink (agent-core 0.5.0), which
// writes runs and run_calls through the async engine (db/engine) and stamps each run with the user it runs as
// (db/scope.ts) in the same insert, so run history and Claude spend are per user. The statements are plain SQL with
// RETURNING id rather than SQLite's last insert id, so the sink works on any engine. Every write waits its turn
// behind an open transaction like any other statement.
import { createTracer } from '@scottmroth5/agent-core';
import type { Run, TraceSink } from '@scottmroth5/agent-core';
import type { Db } from '../db/engine/types.ts';
import type { Logger } from './types.ts';

/** Writes a run, its calls, and its totals; meta and summary are stored as JSON text. */
export function jobSink(db: Db): TraceSink {
  const insertCall = db.prepare(`INSERT INTO run_calls
    (run_id, label, model, stop_reason, input_tokens, output_tokens, cache_read_tokens,
     cache_write_tokens, cost_usd, duration_ms, error_name, error_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return {
    async startRun({ name, meta, startedAt }) {
      const row = (await db
        .prepare('INSERT INTO runs (name, meta, started_at, user_id) VALUES (?, ?, ?, @uid) RETURNING id')
        .get(name, JSON.stringify(meta), startedAt)) as { id: number } | undefined;
      if (!row) throw new Error('trace: the runs insert returned no id');
      return Number(row.id);
    },
    async recordCall(runId, c) {
      await insertCall.run(runId, c.label, c.model, c.stopReason, c.inputTokens, c.outputTokens, c.cacheReadTokens,
        c.cacheWriteTokens, c.costUsd, c.durationMs, c.error?.name ?? null, c.error?.message ?? null, c.createdAt);
    },
    async finishRun(runId, f) {
      await db.prepare(`UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, calls = ?, errors = ?,
          input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, summary = ?
        WHERE id = ?`).run(f.status, f.finishedAt, f.durationMs, f.calls, f.errors, f.inputTokens, f.outputTokens,
        f.cacheReadTokens, f.cacheWriteTokens, f.costUsd, f.summary === undefined ? null : JSON.stringify(f.summary), runId);
    },
  };
}

/** createTracer's API; with a store, each run is written with runs.user_id. Without one, runs stay in memory. */
export function createJobTracer({ store, logger }: { store?: { db: Db } | null; logger?: Logger | null } = {}) {
  const tracer = createTracer({ ...(store ? { sink: jobSink(store.db) } : {}), ...(logger ? { logger } : {}) });
  return {
    async startRun(name: string, meta?: object): Promise<Run> {
      const run = await tracer.startRun(name, meta);
      // An agent-core older than 0.5.0 ignores the sink and keeps the run in memory, which would hide its Claude
      // spend from the caps (agents/budget.ts reads run_calls). Fail loudly instead.
      if (store && run.id == null) throw new Error('trace: the run was not stored; agent-core 0.5.0 or newer is required');
      return run;
    },
  };
}
