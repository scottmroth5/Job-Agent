// The durable job queue (v3 Phase 6, decision 0008): background work as task_runs rows, on SQLite or PostgreSQL, in our own
// portable SQL. The only code that touches task_runs, task_lines, task_types and pool_settings.
//
// - enqueue: a row with the type's pool and priority (a user's own request goes in the interactive band above every
//   scheduled priority). A turned-off type refuses a user's request, and records a scheduled one as skipped.
// - claim (inside one db.tx, which both engines run one at a time across processes, so a job is never handed out
//   twice): the pool's queued, due jobs whose dependency has finished, minus any that would break a limit (the pool's
//   concurrency, the per-user limit with user_id as the fairness group, one-at-a-time per user or across the app, and
//   the workers reserved for interactive work), highest effective priority first: the stored priority plus one level
//   per aging_minutes waited, capped below the interactive band, so scheduled work never starves. Running jobs are never
//   interrupted.
// - run: the handler runs as the job's user (runAsUser), its output goes to task_lines, its heartbeat is renewed, and a
//   timeout aborts it. A failure retries with backoff while the type allows (AI types allow none: a repeat costs money);
//   past the limit it is dead (when retries were allowed) or failed.
// - sweep: a running job whose heartbeat stopped (its worker died) is retried or failed visibly, and its runs row closed.
// - prune: finished jobs and their lines go after RETENTION_DAYS.
// This file names user_id itself (test/user-scope.test.js exempts it): the queue works across users, through the
// unscoped database handle, and every read for a person is filtered to their own rows.
import { randomUUID } from 'node:crypto';
import { runAsUser } from '../../db/scope.ts';
import type { Db } from '../../db/engine/types.ts';
import type { PoolSettingsRow, TaskRunsRow, TaskTypesRow } from '../../db/types.ts';

export const POOLS = ['browser', 'ai', 'io'] as const;
export type Pool = (typeof POOLS)[number];
/** A user's own request runs this far above any scheduled priority (aging never reaches it). */
export const INTERACTIVE_BAND = 1000;
export const FINISHED = ['done', 'failed', 'dead', 'skipped', 'cancelled'];
export const MAX_LINES = 5000;
export const RETENTION_DAYS = 30;
/** A level for progress steps that are not output lines of their own (the pipeline's parsed "Step" lines). */
export const PROGRESS = 'progress';

export interface Job {
  id: string;
  userId: number;
  type: string;
  pool: Pool;
  priority: number;
  interactive: boolean;
  status: string;
  requestedBy: 'user' | 'schedule';
  payload: unknown;
  result: unknown;
  error: string | null;
  attempts: number;
  dependsOn: string | null;
  parentId: string | null;
  runId: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Logger {
  info: (...parts: unknown[]) => void;
  warn: (...parts: unknown[]) => void;
  error: (...parts: unknown[]) => void;
  log: (...parts: unknown[]) => void;
}

export interface HandlerContext {
  job: Job;
  /** A progress step (shown as the task's latest step); also an output line unless log is false. */
  step: (message: string, opts?: { log?: boolean }) => void;
  logger: Logger;
  /** Aborted when the type's timeout passes or the queue stops. */
  signal: AbortSignal;
  /** Links the task to its traced run (runs.id), for cost totals. */
  setRunId: (id: number) => Promise<void>;
}
export type Handler = (ctx: HandlerContext) => Promise<unknown>;

/** A failure that must not be retried, whatever the type allows (the handler knows a repeat would be wrong). */
export class NoRetry extends Error {}

const parse = (text: string | null): unknown => {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const toJob = (r: TaskRunsRow): Job => ({
  id: r.id,
  userId: r.user_id,
  type: r.type,
  pool: r.pool as Pool,
  priority: r.priority,
  interactive: r.interactive === 1,
  status: r.status,
  requestedBy: r.requested_by as 'user' | 'schedule',
  payload: parse(r.payload),
  result: parse(r.result),
  error: r.error,
  attempts: r.attempts,
  dependsOn: r.depends_on,
  parentId: r.parent_id,
  runId: r.run_id,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const textOf = (parts: unknown[]) => parts.map((p) => (p instanceof Error ? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');

export interface QueueOptions {
  /** The unscoped database handle: the queue reads and claims across users. */
  db: Db;
  now?: () => Date;
  /** This process's name in task_runs.worker. */
  worker?: string;
  pollMs?: number;
  heartbeatMs?: number;
  /** A running job whose heartbeat is older than this is treated as abandoned. */
  staleMs?: number;
  sweepMs?: number;
  log?: { info?: (text: string) => void; warn?: (text: string) => void };
  /** The first retry's delay, doubled for each later attempt (default 30 seconds; tests make it short). */
  retryDelayMs?: number;
}

export function createQueue({ db, now = () => new Date(), worker = randomUUID(), pollMs = 1000, heartbeatMs = 15_000, staleMs = 120_000, sweepMs = 60_000, retryDelayMs = 30_000, log = console }: QueueOptions) {
  const iso = (d = now()) => d.toISOString();

  async function typeOf(type: string) {
    return (await db.prepare('SELECT * FROM task_types WHERE id = ?').get(type)) as TaskTypesRow | undefined;
  }
  async function typeMap() {
    return new Map(((await db.prepare('SELECT * FROM task_types').all()) as TaskTypesRow[]).map((t) => [t.id, t]));
  }

  // ---- enqueue -------------------------------------------------------------------------------------------------------
  const wakers = new Set<(pool: Pool) => void>();

  async function enqueue(
    type: string,
    payload: unknown,
    { userId, interactive = false, requestedBy = interactive ? 'user' : 'schedule', dependsOn = null, parentId = null, runAfter = null, onlyOne = null }: {
      userId: number;
      /** Refuse (409, with this message) while the user has a task of this type waiting or running; checked in the same transaction. */
      onlyOne?: string | null;
      interactive?: boolean;
      requestedBy?: 'user' | 'schedule';
      dependsOn?: string | null;
      parentId?: string | null;
      runAfter?: Date | null;
    },
  ): Promise<{ id: string; status: string }> {
    const t = await typeOf(type);
    if (!t) throw new Error(`Unknown task type "${type}"`);
    const r = await db.tx(async () => {
      if (onlyOne && (await db.prepare("SELECT 1 FROM task_runs WHERE user_id = ? AND type = ? AND status IN ('queued', 'running')").get(userId, type))) {
        throw Object.assign(new Error(onlyOne), { statusCode: 409 });
      }
      return insert(t, type, payload, { userId, interactive, requestedBy, dependsOn, parentId, runAfter });
    });
    if (r.status === 'queued') for (const wake of wakers) wake(t.pool as Pool);
    return r;
  }

  async function insert(
    t: TaskTypesRow,
    type: string,
    payload: unknown,
    { userId, interactive, requestedBy, dependsOn, parentId, runAfter }: { userId: number; interactive: boolean; requestedBy: string; dependsOn: string | null; parentId: string | null; runAfter: Date | null },
  ) {
    const id = randomUUID();
    const at = iso();
    const base = { id, userId, type, pool: t.pool, interactive: interactive ? 1 : 0, requestedBy, payload: payload === undefined ? null : JSON.stringify(payload), dependsOn, parentId, at };
    if (t.enabled !== 1) {
      if (requestedBy === 'user') throw Object.assign(new Error(`${t.label} is turned off for now.`), { statusCode: 409 });
      await db
        .prepare(`INSERT INTO task_runs (id, user_id, type, pool, priority, interactive, status, requested_by, payload, error, run_after, depends_on, parent_id, created_at, finished_at)
          VALUES (@id, @userId, @type, @pool, 0, @interactive, 'skipped', @requestedBy, @payload, 'Turned off in Admin > Jobs.', @at, @dependsOn, @parentId, @at, @at)`)
        .run(base);
      return { id, status: 'skipped' };
    }
    await db
      .prepare(`INSERT INTO task_runs (id, user_id, type, pool, priority, interactive, status, requested_by, payload, run_after, depends_on, parent_id, created_at)
        VALUES (@id, @userId, @type, @pool, @priority, @interactive, 'queued', @requestedBy, @payload, @runAfter, @dependsOn, @parentId, @at)`)
      .run({ ...base, priority: t.priority + (interactive ? INTERACTIVE_BAND : 0), runAfter: runAfter ? iso(runAfter) : at });
    return { id, status: 'queued' };
  }

  // ---- claim ---------------------------------------------------------------------------------------------------------
  const effective = (c: TaskRunsRow, t: TaskTypesRow | undefined, nowMs: number) => {
    if (c.interactive === 1 || !t?.aging_minutes) return c.priority;
    const waited = (nowMs - Date.parse(c.created_at)) / 60_000;
    return Math.min(c.priority + Math.floor(waited / t.aging_minutes), INTERACTIVE_BAND - 1);
  };

  /** The next job this pool may start, marked running for this worker; null when none may start now. */
  async function claim(pool: Pool, handled: (type: string) => boolean = () => true): Promise<Job | null> {
    return db.tx(async () => {
      const s = (await db.prepare('SELECT * FROM pool_settings WHERE pool = ?').get(pool)) as PoolSettingsRow | undefined;
      if (!s) return null;
      const running = (await db.prepare("SELECT id, user_id, type, pool FROM task_runs WHERE status = 'running'").all()) as Array<Pick<TaskRunsRow, 'id' | 'user_id' | 'type' | 'pool'>>;
      // A parent waiting on its child tasks (the pipeline and its steps) holds no worker: it would otherwise take the
      // slot its own children need. It still counts for one-at-a-time.
      const waiting = new Set((await db.prepare("SELECT DISTINCT parent_id FROM task_runs WHERE parent_id IS NOT NULL AND status IN ('queued', 'running')").pluck().all()) as string[]);
      const inPool = running.filter((r) => r.pool === pool && !waiting.has(r.id));
      const free = s.concurrency - inPool.length;
      if (free <= 0) return null;
      const interactiveOnly = free <= s.reserved_for_interactive;
      const t0 = now();
      const candidates = (await db
        .prepare("SELECT * FROM task_runs WHERE status = 'queued' AND pool = ? AND run_after <= ? ORDER BY created_at, id LIMIT 500")
        .all(pool, iso(t0))) as TaskRunsRow[];
      if (!candidates.length) return null;
      const types = await typeMap();
      const deps = [...new Set(candidates.map((c) => c.depends_on).filter((d): d is string => Boolean(d)))];
      const depStatus = new Map<string, string>();
      if (deps.length) {
        const rows = (await db.prepare(`SELECT id, status FROM task_runs WHERE id IN (${deps.map(() => '?').join(', ')})`).all(...deps)) as Array<{ id: string; status: string }>;
        for (const r of rows) depStatus.set(r.id, r.status);
      }
      const perUser = new Map<number, number>();
      for (const r of inPool) perUser.set(r.user_id, (perUser.get(r.user_id) ?? 0) + 1);
      const nowMs = t0.getTime();
      const best = candidates
        .filter((c) => handled(c.type))
        .filter((c) => {
          if (!c.depends_on) return true;
          const st = depStatus.get(c.depends_on);
          return st === undefined || FINISHED.includes(st);
        })
        .filter((c) => !interactiveOnly || c.interactive === 1)
        .filter((c) => (perUser.get(c.user_id) ?? 0) < s.per_user_concurrency)
        .filter((c) => {
          const once = types.get(c.type)?.one_at_a_time ?? 'none';
          if (once === 'none') return true;
          return !running.some((r) => r.type === c.type && (once === 'app' || r.user_id === c.user_id));
        })
        .map((c) => ({ c, p: effective(c, types.get(c.type), nowMs) }))
        .sort((a, b) => b.p - a.p || (a.c.created_at < b.c.created_at ? -1 : a.c.created_at > b.c.created_at ? 1 : a.c.id < b.c.id ? -1 : 1))[0];
      if (!best) return null;
      const at = iso(t0);
      await db
        .prepare("UPDATE task_runs SET status = 'running', started_at = ?, finished_at = NULL, worker = ?, heartbeat_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'")
        .run(at, worker, at, best.c.id);
      return toJob({ ...best.c, status: 'running', started_at: at, finished_at: null, worker, heartbeat_at: at, attempts: best.c.attempts + 1 });
    });
  }

  // ---- finishing -----------------------------------------------------------------------------------------------------
  const backoffMs = (attempts: number) => Math.min(retryDelayMs * 2 ** Math.max(0, attempts - 1), 30 * 60_000);

  async function complete(id: string, result: unknown) {
    await db
      .prepare("UPDATE task_runs SET status = 'done', result = ?, error = NULL, finished_at = ?, heartbeat_at = NULL WHERE id = ? AND status = 'running'")
      .run(result === undefined ? null : JSON.stringify(result), iso(), id);
  }

  /** A failed attempt: queued again after a backoff while the type allows, else dead (retries ran out) or failed. */
  async function fail(job: Pick<Job, 'id' | 'type' | 'attempts' | 'runId'>, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const t = await typeOf(job.type);
    const limit = t?.retry_limit ?? 0;
    const at = iso();
    if (!(err instanceof NoRetry) && job.attempts <= limit) {
      await db
        .prepare("UPDATE task_runs SET status = 'queued', error = ?, run_after = ?, worker = NULL, heartbeat_at = NULL, started_at = NULL WHERE id = ? AND status = 'running'")
        .run(message, iso(new Date(now().getTime() + backoffMs(job.attempts))), job.id);
    } else {
      await db
        .prepare('UPDATE task_runs SET status = ?, error = ?, finished_at = ?, heartbeat_at = NULL WHERE id = ? AND status = ?')
        .run(limit > 0 ? 'dead' : 'failed', message, at, job.id, 'running');
    }
    // The traced run the attempt opened, if it never closed itself.
    if (job.runId) await db.prepare("UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ? AND status = 'running'").run(at, job.runId);
  }

  async function heartbeat(id: string) {
    await db.prepare("UPDATE task_runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'").run(iso(), id);
  }

  /** Abandoned jobs (their worker stopped): retried or failed, and their runs rows closed. Returns how many. */
  async function sweep() {
    const cutoff = iso(new Date(now().getTime() - staleMs));
    const stale = (await db.prepare("SELECT * FROM task_runs WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)").all(cutoff)) as TaskRunsRow[];
    for (const r of stale) await fail(toJob(r), new Error('The worker stopped before this task finished.'));
    return stale.length;
  }

  /** Finished jobs and their lines older than days. Returns how many jobs. */
  async function prune(days = RETENTION_DAYS) {
    const cutoff = iso(new Date(now().getTime() - days * 86_400_000));
    const finished = `status IN (${FINISHED.map(() => '?').join(', ')}) AND finished_at < ?`;
    return db.tx(async () => {
      await db.prepare(`DELETE FROM task_lines WHERE task_id IN (SELECT id FROM task_runs WHERE ${finished})`).run(...FINISHED, cutoff);
      return (await db.prepare(`DELETE FROM task_runs WHERE ${finished}`).run(...FINISHED, cutoff)).changes;
    });
  }

  // ---- reading (always for one user) ---------------------------------------------------------------------------------
  async function get(id: string, uid: number) {
    const r = (await db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?').get(id, uid)) as TaskRunsRow | undefined;
    return r ? toJob(r) : null;
  }

  /** The user's tasks, newest first; a parent's child tasks (the pipeline's steps) show in their parent's output instead. */
  async function list(uid: number, limit = 100) {
    return ((await db.prepare('SELECT * FROM task_runs WHERE user_id = ? AND parent_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ?').all(uid, limit)) as TaskRunsRow[]).map(toJob);
  }

  /** A task's steps (its progress messages, oldest first). */
  async function steps(id: string, uid: number) {
    return (await db
      .prepare("SELECT at, text AS message FROM task_lines WHERE task_id = ? AND user_id = ? AND level IN ('step', 'progress') ORDER BY seq")
      .all(id, uid)) as Array<{ at: string; message: string }>;
  }

  /**
   * Output lines from index from on (progress steps are not output lines, so indexes count output only, as lineCount
   * does); next is the index for the following call.
   */
  async function lines(id: string, uid: number, from = 0) {
    const rows = (await db
      .prepare(`SELECT at, level, text FROM task_lines WHERE task_id = ? AND user_id = ? AND level <> '${PROGRESS}' ORDER BY seq LIMIT ? OFFSET ?`)
      .all(id, uid, MAX_LINES + 1, from)) as Array<{ at: string; level: string; text: string }>;
    return { lines: rows, next: from + rows.length };
  }

  async function lineCount(id: string, uid: number) {
    return Number(await db.prepare(`SELECT COUNT(*) FROM task_lines WHERE task_id = ? AND user_id = ? AND level <> '${PROGRESS}'`).pluck().get(id, uid));
  }

  /** The user's newest waiting or running task of this type, or null (one check or pipeline at a time per user). */
  async function active(uid: number, type: string) {
    const r = (await db
      .prepare("SELECT * FROM task_runs WHERE user_id = ? AND type = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1")
      .get(uid, type)) as TaskRunsRow | undefined;
    return r ? toJob(r) : null;
  }

  /** Whether anyone's task of this type is waiting or running (a pipeline is one at a time across the app). */
  async function anyActive(type: string) {
    return Boolean(await db.prepare("SELECT 1 FROM task_runs WHERE type = ? AND status IN ('queued', 'running') LIMIT 1").get(type));
  }

  /** How many tasks of this type the user started since the time given (per-day limits that survive a restart). */
  async function countSince(uid: number, type: string, since: Date) {
    return Number(await db.prepare('SELECT COUNT(*) FROM task_runs WHERE user_id = ? AND type = ? AND created_at >= ?').pluck().get(uid, type, iso(since)));
  }

  /** The user a task belongs to (tests and the scheduler, which wait on a task they started). */
  async function ownerOf(id: string) {
    return ((await db.prepare('SELECT user_id FROM task_runs WHERE id = ?').pluck().get(id)) as number | undefined) ?? null;
  }

  /** Resolves with the job once it has finished, or as it is when the time runs out. */
  async function wait(id: string, uid: number, timeoutMs = 10_000, everyMs = 200) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const job = await get(id, uid);
      if (!job || FINISHED.includes(job.status) || Date.now() >= until) return job;
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }

  /**
   * Stores a finished task with its output, as if it had run (the demo's sample tasks, scripts/demo-seed.js). Each line
   * with a step is a progress step, others output at their level.
   */
  async function record({ userId, type, payload = null, status = 'done', result = null, lines = [], startedAt, finishedAt }: {
    userId: number;
    type: string;
    payload?: unknown;
    status?: 'done' | 'failed';
    result?: unknown;
    lines?: Array<{ step?: string; level?: string; text?: string }>;
    startedAt: Date;
    finishedAt: Date;
  }) {
    const t = await typeOf(type);
    if (!t) throw new Error(`Unknown task type "${type}"`);
    const id = randomUUID();
    await db.tx(async () => {
      await db
        .prepare(`INSERT INTO task_runs (id, user_id, type, pool, priority, interactive, status, requested_by, payload, result, attempts, run_after, created_at, started_at, finished_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, 'schedule', ?, ?, 1, ?, ?, ?, ?)`)
        .run(id, userId, type, t.pool, t.priority, status, payload == null ? null : JSON.stringify(payload), result == null ? null : JSON.stringify(result), iso(startedAt), iso(startedAt), iso(startedAt), iso(finishedAt));
      const add = db.prepare('INSERT INTO task_lines (task_id, user_id, seq, at, level, text) VALUES (?, ?, ?, ?, ?, ?)');
      for (const [seq, l] of lines.entries()) await add.run(id, userId, seq, iso(startedAt), l.step ? 'step' : (l.level ?? 'info'), l.step ?? l.text ?? '');
    });
    return id;
  }

  // ---- the admin's actions on dead letters ---------------------------------------------------------------------------
  async function retry(id: string) {
    const again = (await db
      .prepare("UPDATE task_runs SET status = 'queued', attempts = 0, error = NULL, run_after = ?, finished_at = NULL, worker = NULL, heartbeat_at = NULL WHERE id = ? AND status IN ('dead', 'failed')")
      .run(iso(), id)).changes > 0;
    if (again) for (const wake of wakers) for (const pool of POOLS) wake(pool);
    return again;
  }

  async function discard(id: string) {
    return (await db.prepare("UPDATE task_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('dead', 'queued')").run(iso(), id)).changes > 0;
  }

  // ---- Admin > Jobs (app-wide, admins only: server/jobs-admin-routes.ts) ----------------------------------------------
  /** Per pool: its settings, how many tasks run and wait, failures in the last day, and how long the oldest has waited. */
  async function overview() {
    const t = now();
    const dayAgo = iso(new Date(t.getTime() - 86_400_000));
    const pools = (await db.prepare('SELECT * FROM pool_settings ORDER BY pool').all()) as PoolSettingsRow[];
    const rows = (await db
      .prepare("SELECT pool, status, created_at FROM task_runs WHERE status IN ('queued', 'running') OR (status IN ('failed', 'dead') AND finished_at >= ?)")
      .all(dayAgo)) as Array<Pick<TaskRunsRow, 'pool' | 'status' | 'created_at'>>;
    const order = new Map(POOLS.map((p, i) => [p, i]));
    return pools
      .sort((a, b) => (order.get(a.pool as Pool) ?? 9) - (order.get(b.pool as Pool) ?? 9))
      .map((p) => {
        const mine = rows.filter((r) => r.pool === p.pool);
        const waiting = mine.filter((r) => r.status === 'queued');
        const oldest = waiting.reduce<string | null>((o, r) => (!o || r.created_at < o ? r.created_at : o), null);
        return {
          pool: p.pool,
          concurrency: p.concurrency,
          perUser: p.per_user_concurrency,
          reserved: p.reserved_for_interactive,
          running: mine.filter((r) => r.status === 'running').length,
          waiting: waiting.length,
          failedToday: mine.filter((r) => r.status === 'failed' || r.status === 'dead').length,
          oldestWaitSeconds: oldest ? Math.max(0, Math.round((t.getTime() - Date.parse(oldest)) / 1000)) : null,
          updatedAt: p.updated_at,
        };
      });
  }

  async function types() {
    return ((await db.prepare('SELECT * FROM task_types ORDER BY pool, priority DESC, id').all()) as TaskTypesRow[]).map((r) => ({
      id: r.id,
      label: r.label,
      pool: r.pool,
      priority: r.priority,
      enabled: r.enabled === 1,
      oneAtATime: r.one_at_a_time,
      retryLimit: r.retry_limit,
      timeoutSeconds: r.timeout_seconds,
      agingMinutes: r.aging_minutes,
      updatedAt: r.updated_at,
    }));
  }

  /** The last changes to task types, newest first. */
  async function typeHistory(limit = 50) {
    return (await db
      .prepare('SELECT h.type_id AS "typeId", h.field, h.old_value AS "oldValue", h.new_value AS "newValue", h.changed_at AS "changedAt", u.email AS "changedBy" FROM task_type_history h LEFT JOIN users u ON u.id = h.changed_by ORDER BY h.id DESC LIMIT ?')
      .all(limit)) as Array<{ typeId: string; field: string; oldValue: string | null; newValue: string | null; changedAt: string; changedBy: string | null }>;
  }

  /**
   * Changes a task type's settings and records each changed field; a new priority applies to tasks already waiting
   * when applyToWaiting. Returns the fields changed. The read and the writes are one transaction.
   */
  async function updateType(
    id: string,
    patch: Partial<{ priority: number; enabled: boolean; oneAtATime: 'none' | 'user' | 'app'; retryLimit: number; timeoutSeconds: number; agingMinutes: number | null }>,
    { by, applyToWaiting = false }: { by: number | null; applyToWaiting?: boolean },
  ) {
    const COLUMNS = { priority: 'priority', enabled: 'enabled', oneAtATime: 'one_at_a_time', retryLimit: 'retry_limit', timeoutSeconds: 'timeout_seconds', agingMinutes: 'aging_minutes' } as const;
    const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
    const int = (v: unknown, min: number, max: number, name: string) => {
      if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw bad(`${name} must be a whole number from ${min} to ${max}.`);
      return v as number;
    };
    if (patch.priority !== undefined) int(patch.priority, 0, INTERACTIVE_BAND - 1, 'Priority');
    if (patch.retryLimit !== undefined) int(patch.retryLimit, 0, 5, 'Retries');
    if (patch.timeoutSeconds !== undefined) int(patch.timeoutSeconds, 30, 86_400, 'The time limit (seconds)');
    if (patch.agingMinutes != null) int(patch.agingMinutes, 1, 1440, 'Aging (minutes)');
    if (patch.oneAtATime !== undefined && !['none', 'user', 'app'].includes(patch.oneAtATime)) throw bad('One at a time is none, user, or app.');
    const at = iso();
    return db.tx(async () => {
      const old = (await db.prepare('SELECT * FROM task_types WHERE id = ?').get(id)) as TaskTypesRow | undefined;
      if (!old) throw Object.assign(new Error('No such task type.'), { statusCode: 404 });
      const changed: string[] = [];
      for (const [key, column] of Object.entries(COLUMNS) as Array<[keyof typeof COLUMNS, string]>) {
        if (patch[key] === undefined) continue;
        const value = key === 'enabled' ? (patch.enabled ? 1 : 0) : patch[key];
        const before = (old as unknown as Record<string, unknown>)[column]; // the row's columns, by name
        if (before === value) continue;
        await db.prepare(`UPDATE task_types SET ${column} = ?, updated_by = ?, updated_at = ? WHERE id = ?`).run(value, by, at, id);
        await db
          .prepare('INSERT INTO task_type_history (type_id, field, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, column, before == null ? null : String(before), value == null ? null : String(value), by, at);
        changed.push(column);
      }
      let requeued = 0;
      if (applyToWaiting && patch.priority !== undefined) {
        requeued = (await db
          .prepare(`UPDATE task_runs SET priority = ? + CASE WHEN interactive = 1 THEN ${INTERACTIVE_BAND} ELSE 0 END WHERE type = ? AND status = 'queued'`)
          .run(patch.priority, id)).changes;
      }
      return { changed, requeued };
    });
  }

  /** Changes a pool's limits: concurrency at least 1; per user and reserved within it (reserved leaves one for scheduled work). */
  async function updatePool(pool: string, patch: { concurrency: number; perUser: number; reserved: number }, { by }: { by: number | null }) {
    const { concurrency, perUser, reserved } = patch;
    const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
    if (!POOLS.includes(pool as Pool)) throw Object.assign(new Error('No such pool.'), { statusCode: 404 });
    if (![concurrency, perUser, reserved].every(Number.isInteger) || concurrency < 1 || concurrency > 20) throw bad('Workers must be a whole number from 1 to 20.');
    if (perUser < 1 || perUser > concurrency) throw bad('Per user must be from 1 to the number of workers.');
    if (reserved < 0 || reserved >= concurrency) throw bad('Reserved must leave at least one worker for scheduled work.');
    await db
      .prepare('UPDATE pool_settings SET concurrency = ?, per_user_concurrency = ?, reserved_for_interactive = ?, updated_by = ?, updated_at = ? WHERE pool = ?')
      .run(concurrency, perUser, reserved, by, iso(), pool);
    for (const wake of wakers) wake(pool as Pool);
  }

  /** Tasks whose retries ran out (dead letters), newest first: their kind, account, and error only. */
  async function deadLetters(limit = 50) {
    return (await db
      .prepare(`SELECT t.id, t.type, t.attempts, t.error, t.created_at AS "createdAt", t.finished_at AS "finishedAt", u.email AS "user"
        FROM task_runs t LEFT JOIN users u ON u.id = t.user_id WHERE t.status = 'dead' ORDER BY t.finished_at DESC LIMIT ?`)
      .all(limit)) as Array<{ id: string; type: string; attempts: number; error: string | null; createdAt: string; finishedAt: string | null; user: string | null }>;
  }

  /** Per type over the last days: tasks, done, failed, mean run time, and the Claude cost of the runs they opened. */
  async function totals(days = 30) {
    const since = iso(new Date(now().getTime() - days * 86_400_000));
    const rows = (await db.prepare('SELECT type, status, started_at, finished_at FROM task_runs WHERE created_at >= ?').all(since)) as Array<
      Pick<TaskRunsRow, 'type' | 'status' | 'started_at' | 'finished_at'>
    >;
    const costs = (await db
      .prepare('SELECT t.type, SUM(c.cost_usd) AS cost FROM task_runs t JOIN run_calls c ON c.run_id = t.run_id WHERE t.created_at >= ? GROUP BY t.type')
      .all(since)) as Array<{ type: string; cost: number | null }>;
    const byType = new Map<string, { type: string; tasks: number; done: number; failed: number; seconds: number[]; costUsd: number }>();
    for (const r of rows) {
      const e = byType.get(r.type) ?? { type: r.type, tasks: 0, done: 0, failed: 0, seconds: [], costUsd: 0 };
      e.tasks += 1;
      if (r.status === 'done') e.done += 1;
      if (r.status === 'failed' || r.status === 'dead') e.failed += 1;
      if (r.started_at && r.finished_at) e.seconds.push((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000);
      byType.set(r.type, e);
    }
    for (const c of costs) {
      const e = byType.get(c.type);
      if (e) e.costUsd = Number(c.cost ?? 0);
    }
    return [...byType.values()]
      .map(({ seconds, ...e }) => ({ ...e, meanSeconds: seconds.length ? Math.round(seconds.reduce((a, b) => a + b, 0) / seconds.length) : null, costUsd: Math.round(e.costUsd * 10000) / 10000 }))
      .sort((a, b) => b.tasks - a.tasks || a.type.localeCompare(b.type));
  }

  // ---- running jobs --------------------------------------------------------------------------------------------------
  async function runJob(job: Job, handler: Handler, stopping: AbortSignal) {
    const t = await typeOf(job.type);
    let seq = Number(await db.prepare('SELECT COALESCE(MAX(seq), -1) FROM task_lines WHERE task_id = ?').pluck().get(job.id)) + 1;
    let chain: Promise<unknown> = Promise.resolve();
    let truncated = false;
    const write = (level: string, text: string) => {
      chain = chain
        .then(async () => {
          if (seq >= MAX_LINES) {
            if (!truncated) {
              truncated = true;
              await db.prepare('INSERT INTO task_lines (task_id, user_id, seq, at, level, text) VALUES (?, ?, ?, ?, ?, ?)').run(job.id, job.userId, seq++, iso(), 'warn', `(output truncated at ${MAX_LINES} lines)`);
            }
            return;
          }
          await db.prepare('INSERT INTO task_lines (task_id, user_id, seq, at, level, text) VALUES (?, ?, ?, ?, ?, ?)').run(job.id, job.userId, seq++, iso(), level, text);
        })
        .catch((err: Error) => log.warn?.(`[queue] a line of ${job.type} was not saved (${err.name})`));
    };
    const at = (level: string) => (...parts: unknown[]) => {
      for (const line of textOf(parts).split('\n')) if (line.length) write(level, line);
    };
    const logger: Logger = { info: at('info'), warn: at('warn'), error: at('error'), log: at('info') };
    const controller = new AbortController();
    const onStop = () => controller.abort(new Error('The server is stopping.'));
    stopping.addEventListener('abort', onStop, { once: true });
    const beat = setInterval(() => void heartbeat(job.id).catch(() => {}), heartbeatMs);
    beat.unref?.();
    const limit = setTimeout(() => controller.abort(new Error(`Timed out after ${t?.timeout_seconds ?? 0} seconds.`)), (t?.timeout_seconds ?? 3600) * 1000);
    limit.unref?.();
    const ctx: HandlerContext = {
      job,
      step: (message, opts = {}) => write(opts.log === false ? PROGRESS : 'step', message),
      logger,
      signal: controller.signal,
      setRunId: async (id) => {
        job.runId = id;
        await db.prepare('UPDATE task_runs SET run_id = ? WHERE id = ?').run(id, job.id);
      },
    };
    try {
      const work = runAsUser(job.userId, () => handler(ctx));
      const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason as Error), { once: true }));
      const result = await Promise.race([work, aborted]);
      await chain;
      await complete(job.id, result);
    } catch (err) {
      logger.error((err as Error).message ?? String(err));
      await chain;
      // A stop is not the job's fault: leave it running for the sweep (another worker, or this one after restart).
      if (stopping.aborted) return;
      await fail(job, err);
    } finally {
      clearInterval(beat);
      clearTimeout(limit);
      stopping.removeEventListener('abort', onStop);
    }
  }

  /**
   * Starts this process's workers for the handled types: a loop per pool that claims while it can, every pollMs and at
   * once when a job is added here or one finishes; and the sweep. stop() ends the loops and waits for running jobs.
   */
  function start(handlers: Record<string, Handler>) {
    const handled = (type: string) => Object.hasOwn(handlers, type);
    const stopping = new AbortController();
    const inFlight = new Set<Promise<void>>();
    const pumping = new Map<Pool, boolean>();
    const again = new Set<Pool>();
    // Polls and sweeps under way, so stop() waits for them before the store can close.
    const busy = new Set<Promise<unknown>>();
    const track = <T>(work: Promise<T>) => {
      busy.add(work);
      void work.finally(() => busy.delete(work)).catch(() => {});
      return work;
    };
    const pump = (pool: Pool) => track(pumpOnce(pool));
    const pumpOnce = async (pool: Pool) => {
      if (stopping.signal.aborted) return;
      if (pumping.get(pool)) {
        again.add(pool);
        return;
      }
      pumping.set(pool, true);
      try {
        while (!stopping.signal.aborted) {
          const job = await claim(pool, handled);
          if (!job) break;
          if (stopping.signal.aborted) {
            // Claimed as the server began to stop: back in the queue, untouched, for the next worker.
            await db.prepare("UPDATE task_runs SET status = 'queued', attempts = attempts - 1, started_at = NULL, worker = NULL, heartbeat_at = NULL WHERE id = ? AND status = 'running'").run(job.id);
            break;
          }
          const p = runJob(job, handlers[job.type] as Handler, stopping.signal).finally(() => {
            inFlight.delete(p);
            // Every pool: a job waiting on this one (depends_on) may be in another.
            for (const next of POOLS) void pump(next);
          });
          inFlight.add(p);
        }
      } catch (err) {
        log.warn?.(`[queue] ${pool}: ${(err as Error).message}`);
      } finally {
        pumping.set(pool, false);
        if (again.delete(pool)) void pump(pool);
      }
    };
    const wake = (pool: Pool) => void pump(pool);
    wakers.add(wake);
    const poll = setInterval(() => {
      for (const pool of POOLS) void pump(pool);
    }, pollMs);
    poll.unref?.();
    const sweeper = setInterval(() => void track(sweep()).then((n) => n && log.info?.(`[queue] swept ${n} abandoned task(s)`)).catch(() => {}), sweepMs);
    sweeper.unref?.();
    // Retention: finished tasks and their lines older than RETENTION_DAYS, every few hours.
    const pruner = setInterval(() => void prune().catch(() => {}), 6 * 3600_000);
    pruner.unref?.();
    void track(sweep()).catch(() => {}); // a restart: tasks the last process left running are dealt with at once
    for (const pool of POOLS) void pump(pool);
    return {
      async stop(waitMs = 10_000) {
        wakers.delete(wake);
        clearInterval(poll);
        clearInterval(sweeper);
        clearInterval(pruner);
        stopping.abort();
        await Promise.race([Promise.allSettled([...inFlight, ...busy]), new Promise((r) => setTimeout(r, waitMs).unref?.())]);
      },
    };
  }

  return { enqueue, claim, complete, fail, heartbeat, sweep, prune, get, list, steps, lines, lineCount, active, anyActive, countSince, ownerOf, wait, record, retry, discard, overview, types, typeHistory, updateType, updatePool, deadLetters, totals, start, worker };
}

export type Queue = ReturnType<typeof createQueue>;
