# 0001: Keep this repository for v3

Status: accepted, 2026-11-02

## Context
v3 changes the language, the database, and how work runs. It could start in a new repository, or continue in this one. The app is running in production with users, CI, a deploy key, secrets, and a published image name.

## Decision
- Keep this repository.
- Tag the last v2 commit `v2-final`. v3 ships as `v3.0.0`.
- Each phase in [docs/v3/PLAN.md](../../v3/PLAN.md) lands as small pull requests, and `main` stays deployable after every merge.

## Consequences
- History, issues, CI, deploy settings, and the image name stay intact. The move from v2 to v3 is visible in one history.
- v2 and v3 code live side by side during the migration, so each phase needs a clear end state, with the old path removed when it is done.
- There is no clean break to fall back to. The way back is `v2-final` and the database backups.
