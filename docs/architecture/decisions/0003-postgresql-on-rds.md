# 0003: PostgreSQL on RDS, after an async change on SQLite

Status: accepted, 2026-11-02

## Context
SQLite through synchronous `better-sqlite3` allows one writer on one host. That blocks running workers as separate services. There are 303 `prepare` calls in application code. Rewriting them for a query builder while also changing the engine would mix two risky changes.

## Decision
- Move to PostgreSQL on Amazon RDS, reached from Lightsail through VPC peering.
- Keep hand-written SQL behind a typed adapter (`db/engine`) with `get`, `all`, `run`, and `tx`.
- Do it in three steps:
  1. **Phase 3:** every call becomes asynchronous, still on SQLite, with transactions serialized by a mutex.
  2. **Phase 4:** the app and tests run on both engines in CI, with row level security as defense in depth.
  3. **Phase 5:** cut over in production, with a rehearsed runbook and a way back.

## Consequences
- A failure in Phase 3 can only come from the async change, and one in Phase 4 only from the engine.
- Backups move from file snapshots to `pg_dump`, and migrations must be expand then contract, since a file copy can no longer undo them.
- **Cost:** about $12 a month for the instance, plus storage and backups. This is checked before anything is created.
- Agent-Core's tracer writes to the store directly. Changing that needs an approved minor release that leaves Health-Review's SQLite path unchanged.
