# Decision records

Short records of significant decisions, numbered in order. Each one gives its context, the decision, and its consequences.
Records are not edited once accepted. A later record marks an earlier one superseded.

| # | Decision | Status |
|---|---|---|
| [0001](0001-keep-this-repository.md) | Keep this repository for v3 | Accepted |
| [0002](0002-typescript-with-type-stripping.md) | TypeScript through Node type stripping | Accepted |
| [0003](0003-postgresql-on-rds.md) | PostgreSQL on RDS, after an async change on SQLite | Accepted |
| [0004](0004-pg-boss-queue.md) | pg-boss behind a JobQueue interface | Replaced by 0008 (our own queue); its pools and tables stand |
| [0005](0005-api-types-generator.md) | Our own API types generator | Accepted |
| [0006](0006-two-database-engines.md) | Two database engines, SQLite and PostgreSQL | Accepted |
| [0007](0007-shared-rds.md) | Production on PostgreSQL, set up like Health-Review, on its RDS instance | Accepted |
| [0008](0008-own-job-queue.md) | Our own job queue in SQL on both engines, not pg-boss | Accepted |
| [0009](0009-layers-in-place.md) | Layers in today's folders, not an npm workspaces move | Accepted |
