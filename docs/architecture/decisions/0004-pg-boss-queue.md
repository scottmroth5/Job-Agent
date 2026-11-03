# 0004: pg-boss behind a JobQueue interface

Status: accepted, pending the Phase 6 spike, 2026-11-02

## Context
Background work runs as in-memory tasks and child processes, with one pipeline at a time across the app. A restart loses tasks, and there is no priority, fairness between users, or retry. An earlier plan used RabbitMQ and Redis. That would mean two more services to run, secure, and pay for.

## Decision
- Use pg-boss, which keeps its queues in the same PostgreSQL database.
- Put it behind a `JobQueue` interface. No other code imports pg-boss.
- **Pools:** three, `browser`, `ai`, and `io`, by the resources each needs.
- **Settings and records:** task types, priorities, and pool limits live in tables, edited on an admin screen. Task records and their output lines live in the database.
- **Payloads** hold IDs only.

**Condition.** Phase 6 starts with a spike on real PostgreSQL. It must confirm:
- the priority direction;
- changing a waiting job's priority;
- reserved capacity (`minPriority`);
- per-user limits across processes (`groupConcurrency`);
- retries, dead letters, and flow dependencies;
- what happens when a worker crashes mid-job.

Its results go in a new record. A behavior that does not hold changes the design there, behind the same interface.

## Consequences
- No separate broker. The queue is backed up and restored with the database.
- Queue load shares the database instance, which is watched through queue depth and oldest wait (Phase 7).
- Handlers must be safe to run twice. AI tasks do not retry automatically, since a repeat costs money.
