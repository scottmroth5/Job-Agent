# 0009: Layers in today's folders, not an npm workspaces move

Status: accepted, 2026-11-18

## Context
Phase 7 splits the app into separately deployed services (an API, a scheduler, and a worker per pool) that share one database. The plan's first step moved the code into npm workspaces: `apps/api`, `apps/web`, `apps/scheduler`, `apps/worker`, `packages/domain`, `packages/db`, `packages/queue`, `packages/contracts` and `packages/observability`.

That move touches all of the roughly 360 source files and every relative import. It also touches CLAUDE.md, the Dockerfile, and every script that deploy.sh, compose.yml and the Windows tasks run by name. The services don't need it: they need code that doesn't reach across layers, and an entry point for each.

Today's folders already form layers:
- `tools/` and `db/` are the platform: dates, HTTP, the Claude client, the queue, and the async engine.
- `agents/` is the job's logic: discovery, scoring, letters and the inbox.
- `server/` is the API.

Seven imports crossed those lines.

## Decision
- **Keep today's folders.** The owner decided this on November 18.
- **ESLint's own `no-restricted-imports` enforces the layers,** in `eslint.config.js`, with no new dependency:
  - `tools/` and `db/` never import `agents/`, `server/` or `apps/`;
  - `agents/` never imports `server/` or `apps/`;
  - Fastify is imported only under `server/` and `apps/`;
  - `pg` only in the database code (`db/`, `tools/backup`);
  - Playwright only in `tools/browser.ts`;
  - better-sqlite3 only in the engine, as before.
- **The seven crossings were moved, not excused:**
  - `server/scheduler.ts` became `tools/scheduler.ts`, a generic timer runner;
  - `server/funnel.ts` became `agents/funnel.ts`, job logic;
  - `agents/budget.ts` became `tools/budget.ts`, the spending caps the Claude client checks;
  - `tools/knowledge.ts`, `tools/baseline.ts` and `db/import-v1.ts` moved to `agents/`, since they read job data.
- **Each service gets a small entry point in `apps/`.** `server/index.js` stays the one-process launcher for local use and the demo.

## Consequences
- Lint fails on a new import that crosses a layer, and the message says which way to move the code.
- Scripts, tests, evals, the demo and the web page are outside the rule: they are apps of their own and may import any layer.
- Revisit if a second deployable needs to be installed or versioned on its own, for example a package published for another repo. That would be the time to make `tools/` and `db/` real workspace packages. The layers this record enforces make that move mechanical.
