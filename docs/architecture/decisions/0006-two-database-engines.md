# 0006: Two database engines, SQLite and PostgreSQL

Status: accepted, 2026-11-13

## Context
Phase 4 adds PostgreSQL, so that production can move to a managed database in Phase 5 (decision 0003). The owner decided on November 13 that SQLite stays supported for good: anyone who runs Job-Agent on their own computer can choose SQLite (one file, nothing to install) or PostgreSQL. The demo moves to PostgreSQL with production, on PGlite (in process, no paid database).

Phase 3 already put every database call behind one async interface (`db/engine/types.ts` `Db`), so a second engine only has to implement that interface.

## Decision
- **One app, one SQL dialect.** App SQL is written once and runs on both engines (`test/portable-sql.test.js` bans SQLite-only syntax). The few fragments the dialects spell differently go through `db/engine/sql.ts` and `Db.dialect` (today, only reading a number out of JSON text).
- **The engine is chosen by `DATABASE_URL`.** A `postgres://` address means PostgreSQL (`db/engine/postgres.ts`, on node-postgres). Without it, the store is SQLite, as before. `openJobStore` stays synchronous: a PostgreSQL store connects and migrates behind `store.ready`, and every statement waits for it.
- **Rows read the same.** On PostgreSQL, bigint and numeric come back as numbers (a bigint too large to be exact throws), and booleans as 1 and 0. `db/types.ts`, generated from SQLite, describes both.
- **New ids only through `RETURNING id`,** on both engines (reading `run().id` otherwise throws).
- **Transactions keep Phase 3's guarantees.** On PostgreSQL each transaction takes an advisory lock for its schema, so transactions run one at a time across every process, as SQLite's `BEGIN IMMEDIATE` did. Statements outside a transaction do not wait, since PostgreSQL never shows them uncommitted rows.
- **Two schema histories.** PostgreSQL starts from `db/postgres/000-baseline.sql` (SQLite's schema and seed rows after 025), not from SQLite's history of table rebuilds. From 026 on, each migration has a SQLite file and a PostgreSQL file of the same name. `test/pg-schema.test.js` holds the two schemas to the same tables, columns, types, nullability, keys, and indexes.
- **Both engines in CI, for good.** `npm test` runs on SQLite; `npm run test:pg` runs the same suite on PostgreSQL (locally from `compose.dev.yml`, in CI from a service container). Tests of what only SQLite has are skipped on PostgreSQL from a reviewed list (`test/engine-skips.test.js`).

## Consequences
- Every migration is written twice, and both suites must pass.
- The SQLite file tools (backups and their monthly check, `report:baseline`, `db:pending`, the pre-migration copy) stay SQLite-only until Phase 5 gives them PostgreSQL versions; on PostgreSQL they stop and say so.
- Row-level security on PostgreSQL (Phase 4, PR 3) adds a second guard behind the `user_id` scoping that both engines keep.
- Revisit if keeping SQLite costs more than the local-install path is worth, for example if a feature needs PostgreSQL-only SQL.
