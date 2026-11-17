# 0008: Our own job queue in SQL on both engines, not pg-boss

Status: accepted, 2026-11-17. Replaces the pg-boss choice in 0004; the rest of 0004 (pools, settings in tables, payloads with ids only) stands.

## Context
Decision 0004 chose pg-boss for Phase 6, pending a spike. Since then, decision 0006 kept SQLite as a supported engine for good: local installs run on it, and the test suite runs on both engines. pg-boss works only on PostgreSQL, so it would need a second, separate queue for SQLite, or leave local installs on the old in-memory runner.

## Decision
The owner decided on November 17, 2026: one queue of our own (`tools/queue/queue.ts`), in the app's portable SQL over `db/engine`, on both engines.

- **Claiming is safe across processes because transactions are.** `db.tx` already runs one transaction at a time across every process: BEGIN IMMEDIATE on SQLite, and on PostgreSQL an advisory lock per schema (decision 0006). A claim reads the queue and marks one job running inside one transaction, so a job is never handed out twice. That needs no `SKIP LOCKED` and no separate broker.
- **Tables (migration 027):**
  - `task_types` (pool, priority, on or off, one at a time per user or per app, retry limit, timeout, aging) and `task_type_history`;
  - `pool_settings` (concurrency, a per-user limit, workers reserved for interactive work);
  - `task_runs`, which is both the queue entry and the task's record;
  - `task_lines`.

  `task_runs` and `task_lines` are user tables, so row security applies to them on PostgreSQL.
- **The rules,** applied at each claim:
  - the pool's concurrency;
  - the per-user limit, with `user_id` as the fairness group;
  - one at a time per user or across the app;
  - workers reserved for interactive work;
  - dependencies, which must have finished;
  - effective priority: the stored priority plus one level per `aging_minutes` waited, capped below the interactive band. A user's own request goes in that band.
- **Running a job:** the handler runs as its user, its output goes to `task_lines`, its heartbeat is renewed, and a timeout aborts it. A failure retries with backoff while the type allows; past the limit it's dead (when retries were allowed) or failed.
- **The sweep** retries or fails a job whose worker stopped, and closes its `runs` row. **Retention** keeps finished jobs for 30 days.

## What the spike confirmed
`test/queue.test.js` runs on SQLite and on PostgreSQL. These are the points 0004 asked the spike to settle:

| Point from 0004 | What the test shows |
|---|---|
| Priority direction | A higher number runs first, and among equals the oldest runs first. A user's own request outranks all scheduled work. |
| Changing a waiting job's priority | The priority is stored on each job, so changing a type changes new work only. The admin screen's "Apply to waiting jobs" updates the rows that are waiting (Phase 6, PR 4). |
| Reserved capacity | A reserved worker takes only interactive work, and running jobs are never interrupted. |
| Per-user limits across processes | Two workers claiming 30 times at once handed out 20 jobs exactly once each, and the per-user and one-at-a-time limits held. |
| Retries, dead letters, dependencies | Backoff retries, a dead letter after the limit, the admin's retry and discard, no retry for AI types or a `NoRetry` failure, and a dependent job waiting until the one before it finishes, whatever its result. |
| A worker crashing mid-job | The sweep finds the stopped heartbeat. It retries a type that allows retries, fails the rest visibly ("the worker stopped"), and closes the `runs` row. A full kill test of the server comes in PR 5. |

## Consequences
- **No new dependency, and no PostgreSQL-only feature.** Local SQLite installs get the same queue, and backups and restores carry it with the database.
- **The cost:** we own the queue code, about 400 lines, and its tests: priorities, aging, reserved workers, limits, retries, dead letters, dependencies, the sweep, retention and isolation. A rule pg-boss has that we need later is ours to build.
- **Claiming runs one at a time across the app.** That's fine at this scale: a few users and one server, with workers polling every second.
- **Out of the queue:** the short synchronous AI calls (draft, revise, letter check, Help), where the user waits on the request directly. They keep their own daily limits.
