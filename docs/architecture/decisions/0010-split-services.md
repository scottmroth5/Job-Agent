# 0010: Five services on one shared database, each with its own settings and login

Status: accepted, 2026-11-19

## Context
Until Phase 7 one container ran the whole app: the routes, the scheduler, all three task pools (browser, ai, io), Chromium, and the pipeline's child scripts.
- **No isolation:** a Chromium crash or a memory spike took sign-in down with it.
- **One set of secrets:** every part held every secret, including the Claude key, both Google sign-ins, the email key, and the key that opens users' own Claude keys.
- **All or nothing:** every deploy restarted everything.

PR 2 made the roles separable (`apps/api.ts`, `apps/worker.ts` with `POOLS=`, `apps/scheduler.ts`). The queue already worked across processes: a claim is one transaction, and both engines serialize those.

## Decision
- **Five services on the one server, sharing the one database:**

  | Service | Image | Runs |
  |---|---|---|
  | `api` | slim | routes, sign-in, short AI calls, account emails |
  | `scheduler` | slim | users' automatic runs; enqueues only |
  | `worker-browser` | full | the browser pool |
  | `worker-ai` | slim | the ai pool |
  | `worker-io` | slim | the io pool |

  - The full image is today's `<tag>`, with Chromium. The slim one, `<tag>-slim`, is the same code without a browser: 785 MB against 2.25 GB.
  - The demo, its database, the backup container and Caddy are unchanged.
- **One database, not one per service.**
  - The services share every table: a task is enqueued by one and claimed by another, and its record is read by the API.
  - Row security already separates users.
  - A database per service would need messaging between them for every task, and would buy no isolation that row security does not already give.
- **Each service gets only its own settings.**
  - `deploy/secrets.json` maps each Parameter Store setting to the services that need it, with a reason.
  - `env-from-ssm.sh` writes `state/env/<service>.env` from it, and refuses a setting the matrix does not list.
  - Examples: the browser worker holds the search key and no Claude, Google, Gmail or session secret; the scheduler holds its database login, its schedules and the time zone.
  - `test/secrets-matrix.test.js` holds the matrix to the code.
- **Each role gets its own database login:** `ja_api`, `ja_worker` (shared by the three workers) and `ja_scheduler`.
  - Each is a member of `ja_app` (`WITH INHERIT TRUE, SET FALSE`), so it inherits the row grants, including those on tables later migrations make, and cannot act as `ja_app` itself.
  - Row security applies to each as it does to `ja_app`.
  - `PGAPPNAME` names the service on every session.
  - Separate logins let one service's access be revoked or rotated alone, and show which service a session belongs to. They do not narrow which rows or tables a service may touch. That would need per-table grants that every migration keeps in step, which we don't think is worth it for one owner.
- **The layout is opt-in on the server:** `server.conf` `LAYOUT=split`, through `deploy/compose.split.yml` on top of `compose.yml`.
  - Without that line, `deploy.sh` runs the one app container exactly as before.
  - Removing the line and running `./deploy.sh up` goes back.
  - `npm run ui` and the demo still run every role in one process.
- **`deploy.sh` deploys per service.**
  - The roles start before the API, so sign-in is down for seconds.
  - `deploy <tag> --only <services>` and `rollback <service>` replace one service alone. Both are refused when the two tags know different migrations: a service never runs code written for another schema.

## Consequences
- **A browser crash or memory spike stays in `worker-browser`.** The API, the scheduler and AI work carry on, and the browser's tasks wait in the queue for it.
- **Five Node processes use more memory than one.** The limits in `compose.split.yml` are a first guess, measured on staging in Phase 7's last PR before production uses the layout.
- **The server holds two images per tag** (three with the backup's). The weekly prune keeps disk use in check.
- **A static test cannot prove a pool never reads a setting,** since one worker image holds every handler. A missing setting fails visibly where it is used (no Claude key, Gmail not set up), and the staging rehearsal runs every task type on the split layout.
- **Revisit when one server is not enough.** The same services could run on separate machines, since the database is the only thing they share. That would need the queue's polling looked at, and nothing else.
