## Purpose
Job Discovery and Job Hunt agents built on the shared agent-core package.
agent-core comes from the public Agent-Core repo as a git dependency pinned to a version tag
("@scottmroth5/agent-core": "github:scottmroth5/Agent-Core#semver:^0.2.3"; meeting prep needs 0.2.2's tools, streaming, and pause_turn resume;
migration 013 needs 0.2.3's foreignKeys: false table rebuilds). Upgrade with npm install "github:scottmroth5/Agent-Core#semver:^<x.y.z>"; test unreleased changes with npm link ../Agent-Core.
Job specific logic stays in this repo; never add it to agent-core.
v3: docs/v3/PLAN.md is the phased plan (one phase at a time, plan mode first, its stop-and-ask list applies); docs/architecture/
holds the current-state diagram and decision records (decisions/NNNN-*.md). v2-final tags the last v2 commit.

## Structure
/agents/discovery   finds, researches, and scores postings: sources/ (one module per job source, parse functions exported for tests),
                    details.js (full text: source, LinkedIn guest endpoint, JSON-LD, page text, browser), discover.js (one run),
                    prompts/*.md templates, schemas/*.json output schemas
/agents/hunt        cover letters, resume tailoring, application tracking, prep.js (meeting prep)
/tools              job specific helpers: config, urls, dates, template, google (auth, docs, gmail), markdown.js (the one safe
                    Markdown renderer, shared by the web page and the prep Google Docs; job notes are Markdown)
/agents/notes.js    a job's notes are separate entries (posting_notes: body, source user/agent/earlier, created_at, updated_at).
                    Change notes only through this module: it keeps postings.notes as every entry's text, oldest first, for
                    code that reads notes as one text. Code that inserts a job with notes text calls adoptNotesText
/db                 SQLite schema (migrations/*.sql plus code migrations listed in db/index.ts, applied in id order), openJobStore, v1 import.
                    db/types.ts is generated (npm run db:types after a new migration): a row type per table, for query results.
                    Rebuild a table only in a migration that exports foreignKeys = false (agent-core runs it with foreign keys off,
                    then foreign_key_check and integrity_check must pass before it commits); in any other migration a drop cascades.
                    013 shows a rebuild (indexes, triggers, and views made again); 008 loosens a CHECK in place (writable_schema).
                    A migration keeps its own copy of any app code it runs (012), since app queries change later. openJobStore takes a checked copy
                    (data/backups/pre-migration-<stamp>.db, newest 5 kept) before any of its migrations changes a file; npm run
                    db:pending migrates a throwaway copy (exit 0 none, 10 pending, 1 failed). Back up data/job-agent.db before schema changes
/scripts            command-line entry points (see Commands)
/config             job-search.example.json: the shape of the real, gitignored data/config/job-search.json
/server             Fastify API over the SQLite store (app.js routes, queries.js, tasks.js, auth.js); serves the built UI
/agents/manual.js   manually added jobs: dedupe, fetch or paste text, score, write materials
/agents/inbox       Gmail inbox: sync.js (historyId cursor, 7-day fallback), prefilter.js, match.js (thread, contact, domain,
                    ATS subject), classify.js (Haiku, fixed untrusted-email system prompt), actions.js (gate, forward-only status),
                    process.js (one run; decideEmail is shared with the eval), review.js. Settings: config/inbox.json
/agents/lookups.js  the configurable status, stage, and track lists (lookup_values, lookup_roles; Admin > Lists). Jobs store each
                    value's immutable text ID. Behavior comes from the value's group (status: evaluate, waiting, conversation,
                    decision, closed; stage: found, active, archived; track settings choose the scoring prompt and pay fields) and
                    from roles (default status/stage/track, promotion stage, archive stage, and 023 status roles for the values the app sets:
                    the inbox moves applied, interview, offer, rejected; duplicate; passed; noResponse). Never compare to a literal status,
                    stage, or track ID for behavior: use lookups(db) helpers and sqlList(). Values are archived, never deleted
/agents/identity.js same-job matching: companyTitleKey (tools/urls.ts) spells out VP/Sr/CTO, drops "of/and/remote" and company suffixes;
                    placeholder companies ("See posting") are read from the Google title. Rule changes need npm run cleanup to rekey
/web                React (Vite) UI: Home (#/, a tile per screen with its count, Run pipeline, the Claude budget), Jobs (#/jobs: stage,
                    status, and search; track, needs description, discovered since, and score under Advanced filters), detail panel,
                    add-job dialog, fractional stacking bar. Pictures: web/public/dash (160 px PNGs) through DashIcon.tsx's map (Home tiles, the Home link, panel headings) Phones get a back link to Home and the screen name instead of tabs
/evals              eval runner and rubric code; real eval cases live in data/evals; evals/inbox/cases.json is synthetic. Results: EVALS.md
/test               node:test suites with synthetic fixtures only; test/fixtures/fakes.js types partial stand-ins (fakeConfig,
                    fakeServices, fakeClaude, fakeHttp, fakeItem, fakeRun, noTimer) and returns them unchanged
/data               gitignored: job-agent.db, config/, google/ (OAuth client and token), attachments/, v1-export/
/legacy contains the v1 scripts for reference only. Do not modify or import from them.

## Commands
npm test                          run all unit tests (no network, no real data)
node --test test/db.test.js       run one suite
npm run typecheck                 tsc --noEmit, strict (tsconfig.json for the server side, web/tsconfig.json for the page)
npm run lint                      the promise rules (no-floating-promises, await-thenable, no-misused-promises) and import type
npm run db:types                  regenerate db/types.ts (a row type per table) from the migrations; CI runs -- --check
npm run api:types                 regenerate web/src/api-types.ts (each route's params, query, body, and response) from
                                  /api/openapi.json (decision 0005); CI runs -- --check
npm run check:personal -- --all   scan every tracked file for personal data (the pre-commit hook checks staged files)
npm run hooks:install             enable the pre-commit guard in a fresh clone
npm run config:from-v1            build data/config/job-search.json from the v1 export
npm run google:login              one-time Google sign-in; saves data/google/token.json
npm run google:check              verify Google access (-- --send-test-email to test Gmail)
npm run import:v1                 one-time import of the v1 sheets into data/job-agent.db (-- --reset to rebuild)
npm run discover                  find new postings from all sources and store them (no scoring)
npm run discover -- --dry-run --limit=20 --sources=himalayas,linkedin --no-details   preview options
npx playwright install chromium   optional: without it, pages that need JavaScript render in the installed Edge or Chrome (PLAYWRIGHT_CHANNEL forces one)
npm run score                     score unscored postings (-- --dry-run for count and cost estimate; --model, --limit, --ids)
npm run eval:score -- --build     build scoring eval cases in data/evals/score (applied vs passed postings)
npm run eval:score -- --models=claude-haiku-4-5,claude-sonnet-5-5 --max-usd=2   compare models; costs real money
npm run eval:letters -- --dry-run   letter fact check eval on synthetic cases (evals/letters): recall on planted errors, false
                                  flags on clean letters; --models=..., --max-usd=1; without --dry-run it costs real money
npm run hunt                      resume tweaks + cover letters (Google Docs) for promoted jobs (-- --dry-run, --ids, --regenerate, --no-docs)
npm run archive -- --dry-run      preview archiving; without --dry-run it moves them
npm run cleanup -- --dry-run      after a rule change: rekey duplicates, archive list-of-jobs pages, search.excludedSites jobs, and duplicate copies (the acted-on copy is kept);
                                  move pipeline jobs without a description back to Discovered. Its status changes are changed_by agent, which the eval ignores
npm run report                    email the report for the last 24 hours (-- --hours=N, --no-email)
npm run pipeline                  discover, score, hunt, archive, then one report email (the scheduler's entry point);
                                  node scripts/pipeline.js --user=<id> runs one user's (no Docs, no email, free sources)
powershell -ExecutionPolicy Bypass -File scripts\register-schedule.ps1   Windows task: scripts/scheduled-run.ps1 runs pipeline then inbox
                                  (Mon/Thu 6:00 by default; -Time, -Days, -Remove); logs in data/logs
npm run ui                        build the React UI and start the server at http://localhost:5178 (API contract: /api/openapi.json)
powershell -ExecutionPolicy Bypass -File scripts\register-server-task.ps1   "Job Agent server" task: builds and starts the server at
                                  sign-in, hidden (scripts\server-start.cmd, logs to data\logs\server.log). While it runs, npm run ui
                                  hits EADDRINUSE: use npm run server:restart after code changes, npm run server:stop to stop it
npm run web:dev                   Vite dev server with hot reload on :5179, forwarding /api to a running npm run ui
npm run add -- --url=...          add a job by hand (also --description-file, --title, --company, --track, --rate, --hours, --write-materials)
npm run inbox:auth                one-time Gmail sign-in (gmail.readonly + gmail.modify); writes GMAIL_REFRESH_TOKEN and EMAIL_ENC_KEY to .env
npm run inbox                     process new Gmail since the stored historyId (inbox:backfill -- --days=N --dry-run for history)
npm run inbox:review              resolve needs_review emails; each choice but Dismiss (not sure: off the list, no action, 019) becomes a case in data/evals/inbox/review-cases.jsonl
                                  (its email text sealed with EMAIL_ENC_KEY as bodyEnc; none for not-job mail; inbox:seal-cases
                                  seals cases written before that)
npm run backup                    encrypted backup (database, data/config/job-search.json, data/attachments) to the "Job Agent
                                  Backups" Drive folder; -- --to <folder> writes it to a folder; -- --check-passphrase checks .env
npm run db:pending                migrations a database open would apply, tried on a throwaway copy (deploy.sh runs it first)
npm run report:baseline           v3 baseline (tools/baseline.ts): rows per table, database and attachment sizes, Claude spend by
                                  month, accounts by status, outcome data gaps; counts only, opened read-only (no migrations).
                                  -- --json; output stays out of the repo
npm run bench                     response times (v3 Phase 3): the main routes on a fresh demo database in the OS temp folder,
                                  through app.inject; median, p95, mean ms (-- --runs=N, --json). Sample data only
npm run bench:demo -- --url=<demo address>   times a few read requests to the public demo (network included, at most 50
                                  runs a route); the address is passed in, never written in the repo
npm run backup:restore -- --file latest --out data/restore/job-agent.db   decrypt into NEW files (never over the live database)
npm run backup:test               restore test: the newest Drive backup (or -- --file <path>) decrypted into the OS temp folder,
                                  integrity-checked, table counts compared with the live database, then deleted. Counts only.
                                  Scheduled monthly (SCHEDULE_RESTORE_TEST, default "monthly 1 05:00" whenever SCHEDULE_BACKUP
                                  is set; "off" disables); a failure emails the owner like any scheduled job
powershell -ExecutionPolicy Bypass -File scripts\register-backup-task.ps1   nightly 11pm backup task ("Job Agent nightly backup";
                                  scripts\backup-nightly.cmd, logs to data\logs\backup.log)
npm run evals                     inbox eval (about $0.06); -- --all adds the scoring eval. Record results in EVALS.md

## Users (multi-user, phases 1 to 6)
db/users.ts: users table, the owner is user 1 (admin); every row before 013 is theirs. Every user table (USER_TABLES in
db/migrations/013-users.ts) has user_id NOT NULL, and keys that were unique app-wide are unique per user. Every query on a
user table says "user_id = @uid" (joins and subqueries too: "s.user_id = p.user_id"); inserts give user_id @uid, or copy it
from the job row (INSERT ... SELECT ... FROM postings WHERE id = ? AND user_id = @uid) so another user's job gets nothing.
store.db is scoped (db/scope.ts): @uid is the user of the current request or job (runAsUser, AsyncLocalStorage), else
fallbackUid: the owner for scripts and tests; the server has none, so a user-table query outside a request or job throws.
store.raw is unscoped: migrations, backups, and server/admin-queries.ts (the admin's cross-user reads: counts and account
facts, never anyone's jobs or key) only.
Accounts (phase 2): any verified Google address signs in (server/auth.ts); AUTH_ALLOWED_EMAILS are the owner's addresses
(accountFor; syncOwnerEmail gives user 1 the first). Anyone else: no row goes to /auth/register (name, note, 18 or older, terms; a form
post, no script; MAX_PENDING open requests at most), pending to /auth/waiting, rejected to /auth/not-approved; API calls get
403 with { account }. Paused accounts get in read-only (no writes, no AI). Admin > Users (server/users-routes.ts, admin role,
never in the demo): approve, reject, pause, resume, and AI setup. server/notices.ts sends the account emails (see Hard rules).
Requests run as their user (server/app.ts: decided in onRequest, run as them from preHandler). OWNER_ONLY routes: the inbox
(the owner's own Gmail; another person's needs Google's restricted-scope review) and what everyone shares (lists, the owner's cap).
Each user's own search (phase 3, agents/user-config.ts): the owner's settings file and Google Doc stay theirs; anyone else saves
search settings (plain text fields only, so no user text becomes a regex: cover letter checks, site search, and private terms
stay the owner's) and their background text on Settings (user_settings). The server's config is userConfigView and
services.knowledge and services.drive answer for the current user (others: their background; no Drive, so letters and preps
stay in the app). scripts/pipeline.js --user=<id> runs as that user: free sources only (Serper is the owner's paid key), no Docs,
no report email (job data goes to nobody but the owner); it refuses an account that is not active or has no complete search.
The Run pipeline button runs the presser's pipeline; one pipeline at a time across the app. Users who turn on "Run my pipeline on
the schedule" run after the owner's scheduled pipeline (and inbox), one by one, each as themselves. Other child scripts run as
the owner; tasks keep their user and the task routes show only that user's.
Per-user settings live in user_settings (getUserSetting: inbox cursor, Drive folders, layouts); app_settings is app-wide
(alerts, the owner's cap, allowance-notice months, demo marker). runs.user_id (014) is stamped by tools/trace.ts
createJobTracer, the only way to start a traced run. App-wide still: lookups (lists) and the pipeline lock.
test/user-scope.test.js fails on any query on a user table that does not name user_id; test/user-isolation.test.js calls
every route as a second user against the owner's demo data; test/registration.test.js covers accounts, emails, and keys.
test/user-search.test.js covers per-user settings, the config view, the pipeline as its presser, and the script's refusals.
Phase 4: Admin > Users shows last seen (users.last_seen_at, touchLastSeen at most every 15 minutes), last pipeline run, and
setup chips (search ready, About you, key, schedule; never the text). Putting a user on the owner's key needs their address
typed (confirmEmail) and emails them; so does taking them off it or changing the cap. Feedback (server/feedback-routes.ts,
feedback table, db/user-tables.ts lists the user tables since 013): any user writes to the owner from Settings, at most
FEEDBACK_PER_DAY a day; it is emailed to the owner with the sender as Reply-To (buildRawEmail allows one plain address) and
listed on Users with Mark done. ADMIN_ONLY prefixes in server/app.ts: /api/admin/users, /api/admin/feedback. The Home Admin
tile counts waiting requests and open feedback (summary.adminWaiting, admins only). test/feedback.test.js covers these.
Phase 5 (per-user lists) was skipped: the status, stage, and track lists stay shared and the owner's to edit.
Phase 6 (agents/account-data.ts): Settings > Your data and account. Download my data (GET /api/account/export: every
user-table row plus the account and runs; never the sealed key or email bodies). Pause (and resume, only when self-paused:
decided_by = self; PAUSED_MAY in server/app.ts lets a paused account resume or delete). Delete my account (typed address):
every user-table row (db/user-tables.ts order), attached file folders, the account; runs on their own key are deleted, runs
on the owner's key are kept for the owner's cap with meta and summary cleared. The owner deletes an account the same way
(POST /api/admin/users/:id/delete). Both email the person; a self-delete also tells the owner. test/account-data.test.js.
Help (#/help, server/help-routes.ts): guides in help/*.md (generic, rendered with tools/markdown.ts) and Ask, answered from
the guides only on the asker's own AI (HELP_MODEL, a traced 'help' run, ASKS_PER_DAY; nothing logged or stored). Time zones:
users.time_zone (016) rides in the request or job context (runAsUser(uid, fn, { timeZone })); tools/dates.ts localDay,
localDaysAgo, dayOf, and timeZone() follow it, else the app's TZ. The owner, scripts, budgets (calendar months), and the
scheduler use the app's zone. test/help-timezone.test.js.
Onboarding: Home shows Get started (summary.setup: AI paid for, About you long enough, search complete) until all three
are done. Build a draft (agents/draft-profile.ts, POST /api/account/draft, Settings > About you): the user's resume and
LinkedIn profile as PDFs (documents), text files and pasted text, and notes go to DRAFT_MODEL on their own AI with
DRAFT_SCHEMA; it returns a draft About you and starting search with [add: ...] gaps and questions. Nothing is saved (the
forms are filled for review), files are never kept, the materials are untrusted data (system prompt), DRAFTS_PER_DAY.
The owner gets it too.
The knowledge doc (About you in code, "Your knowledge doc" in the UI) has seven numbered sections (agents/knowledge-sections.ts):
the default prompts name "Section 5: Job Targets" and "Section 6 (Cover Letter Rules)", so numbers and titles change only with
the prompts. The draft builder writes them, Settings shows a checklist and Start from the template / Add the missing
sections, and test/knowledge-sections.test.js checks the template, the demo's DEMO_ABOUT_YOU, and every example in help/about-you.md.
Everyone's knowledge doc, the owner's included, lives only in the app (user_settings): agents/user-config.ts backgroundFor
(>= 500 characters, else a message saying to write it under Settings) for the server and tools/knowledge.ts ownerBackground
for scripts. There is no Google Doc any more (no YOUR_KNOWLEDGE_DOC_ID, no documents.readonly scope); services.knowledge is
only a test stand-in for the owner's.
Knowledge doc versions: every save (PUT /api/account/profile with source typed, file, draft, or restore) keeps the one
before in user_settings profile.versions (newest first, 20 at most; a doc saved before versions starts the list as earlier);
GET /api/account/profile/versions, /versions/:n, POST /versions/:n/restore, and GET /api/account/profile.docx?version=
(prepDocx). test/knowledge-versions.test.js.
Fill from a document (POST /api/account/profile/from-file) returns a file's text without saving; tools/doc-text.ts reads
PDF (unpdf), .docx (mammoth), and text with no AI call. Resumes (017, agents/resumes.ts, server/resume-routes.ts,
Settings > Resumes): file and text in the resumes table (so backups, export, and deletion cover them; export omits the
blob), a label, plain title words, one default. pickResume chooses per job title; withResume adds its text to the
background for letters, tweaks, and meeting prep (never scoring), and artifacts/meeting_preps record resume_id. Downloads: GET /api/resumes/:id/file?format=original|text|docx|pdf;
tools/resume-format.ts lays the text out as Word (docx) and as a PDF it writes itself (Helvetica, WinAnsi; no library). Guides with a template and made-up examples: help/about-you.md,
help/search-settings.md, help/prompts.md. tools/markdown.ts renders fenced blocks (escaped). test/onboarding.test.js.
Letters and preps in the app: the job panel shows a letter's text (always without a Google Doc, on request with one) with
Copy and Download Word; the prep reader has Download Word too. server/word-docs.ts builds the .docx (the letter in the
Google Doc's layout from the current user's settings; the prep from its Markdown), server/document-routes.ts serves your
own only. test/word-docs.test.js. Each user's own Gmail and Drive
wait on Google's verification of those scopes.

## UI and API
The Home page (#/) opens with Today and upcoming (server/today.ts, summary.today: open reminders due within 14 days or
past due, jobs at an offer, applications worth a follow-up, and one item for all stale ones; each opens its job), then a tile per screen.
The job panel's Next step box is the same list for one job (GET /api/postings/:id nextSteps; every open reminder, however
far out), with Prepare for a meeting and Done (registerReminderRoutes, registered with or without Gmail).
Follow-ups (agents/follow-ups.ts, server/follow-up-routes.ts): no reply from FOLLOW_UP_DAYS (7, server/funnel.ts) until
the user's stale days (Settings > Follow-ups, user_settings followUp.staleDays, default 45; never archived jobs) is a
follow-up with Find someone to contact (agents/hunt/find-contact.ts: Sonnet with web search on the user's AI, prompt
find-contact, the result saved as an agent note) and Close: no response; from the stale days on it is stale, closed one at
a time or all at once (Home: Review via GET /api/follow-ups/stale, then POST close-stale) to the status list's noResponse
role (018: "No response", closed group) with a note and changed_by user history. The Funnel's list uses the same window.
test/follow-ups.test.js. Arrange tiles saves the order (server/layout.ts, PUT /api/layout/home, returned
with /api/summary; web/src/layout.ts arranged() applies it). Installable on an iPhone: web/public/manifest.webmanifest and
icons in web/public (install icons full-bleed, favicons as drawn) made from assets/app-icon-1024.png (kept out of the image);
test/icons.test.js checks their sizes and that they load before sign-in.
AUTH_MODE=none (default) binds to 127.0.0.1 with no login. AUTH_MODE=google (server/auth.ts) is "Sign in with Google":
any verified address gets a session and its account decides the rest (Users above); the session is a signed cookie
(server/session.ts, SESSION_SECRET); every route but /auth/*, /healthz, /privacy and /terms (server/pages.ts, from
PRIVACY.md and TERMS.md), and the Add to Home Screen files (manifest.webmanifest, icon-180/192/512.png) needs it, and writes must come from PUBLIC_URL's origin. Settings live only in .env; npm run auth:setup creates the secret.
server/app.ts holds every route with a JSON schema; keep /api/openapi.json the source of truth for the UI;
web/src/api-types.ts is generated from it (npm run api:types after a route schema change); web/src/api.ts names each call by its
route key ("PATCH /api/postings/:id"), so bodies and fully declared responses are checked, and open response schemas read
as ApiResponse's one Loose (any) type until the route schema is tightened.
The Run pipeline button (server/pipeline-routes.ts) spawns scripts/pipeline.js as its own process and turns its "[pipeline] Step"
lines into task progress; the last run comes from the runs table. The Inbox screen (#/inbox, server/inbox-routes.ts) checks
Gmail in-process, resolves needs_review emails with agents/inbox/review.ts, and closes reminders.
Every task keeps its output (server/tasks.ts: steps plus log lines; pass the task's logger to createJobTracer so run logs land there);
the Activity tab (#/activity/<taskId>) shows it live via GET /api/tasks/:id/log?from=N. Output is job titles and counts, never email content.
Long actions (add, score, write-materials, regenerate, refetch) run as in-memory tasks the UI polls; they refuse to start
while a pipeline step is running. web/dist is build output (gitignored).
A failed scheduled job emails the owner (server/alerts.ts: EMAIL_ADDRESS only, once per kind a day, cleared by the next success).
deploy.sh: when the new image has pending migrations, it backs up to Drive with the current image first and, if the deploy
fails, restores the pre-migration copy before restarting the old image (--no-backup, --skip-db-check for old tags).
The in-app scheduler (server/scheduler.ts) runs SCHEDULE_PIPELINE (then the inbox), SCHEDULE_INBOX, and SCHEDULE_BACKUP from .env
while the server runs, through the same task starters as the buttons (pipeline-routes start, inbox-routes startCheck); it
catches up a run missed in the last 12 hours. GET /api/schedule lists the jobs. It replaces the Windows tasks in the cloud;
never enable both. Child scripts run through services.runScript.
Keyboard and screen readers: job titles and column headers in the Jobs table are real buttons (aria-sort on the header);
the job panel is a dialog that takes focus, keeps Tab inside, and returns focus to its opener; charts carry a table
for screen readers (.sr-only). Keep new controls as buttons or links, not clickable divs or rows.
Attachments (server/attachments.ts): the raw file is the POST body with its name in X-Filename, stored as
data/attachments/<posting id>/<uuid>, never by its name; only PDFs and images open inline, and downloads carry nosniff and a sandbox CSP.

## Prompts
agents/prompts.ts is the single way to load a prompt: getPrompt(db, name) returns the admin-screen edit if one is active
(prompt_versions table, with history), else the repo file, which stays the default. Settings > Prompts (#/settings/prompts, web/src/components/PromptsSettings.tsx, routes /api/prompts in server/admin.ts)
edits every template in PROMPTS for the current user only (prompt_versions is a user table); Admin keeps Lists, Spending,
and Users (all app-wide: the shared lists, the cap on the owner's key, accounts) and is shown to admins only, never in the demo; each
user's own spend by feature is on Settings (GET /api/spending; setting the cap stays PUT /api/admin/budget, owner only); placeholders are validated on save, and output schemas stay read-only in the repo because code reads
their fields. Personal wording belongs in edits or the knowledge doc, never in the repo defaults.

## Tracks
Postings are fulltime or fractional (tools/track.ts). Fractional postings score with prompts/score-fractional.md, which adds
fit (High/Medium/Stretch/Poor), why it fits, caveats, pay and hours; annualized estimates use tools/rates.ts (tracker math).
Go Fractional is bot-protected: it is never scraped, and search.siteSearch stays false unless the Serper plan allows site: queries.

## Hunt
Letters: Sonnet 5.5 at medium effort; v1's cleanup (strip greeting/sign-off, no dashes) and config.coverLetterChecks run in code,
plus a word-limit flag. Letter Docs go to the app's own "Job Agent Cover Letters" Drive folder (drive.file scope).
Nothing is overwritten: --regenerate creates new artifacts and Docs.
The job panel's Cover letter (web/src/components/LetterSection.tsx, server/letter-routes.ts): Revise with Claude
(agents/hunt/revise-letter.ts, Sonnet at medium effort, the knowledge doc plus the job's resume as system, REVISE_SCHEMA,
REVISIONS_PER_DAY; saves nothing), saving a kept revision (source v2-revision) or the user's own text (source user; letters.js
userLetterBody keeps its wording but takes off the header through the greeting and the sign-off on, and rebuilds a
PDF's paragraphs; from-file returns the same body) as a new current version (with a Google Doc for the owner), restoring an older version as
a new one, and Word or PDF downloads of any version (letter.docx / letter.pdf ?version=; tools/pdf-writer.ts letterPdf). Report HTML escapes every value.
The letter header is each user's own (agents/letter-header.ts, user_settings letter.header, Settings > Cover letter
header, GET/PUT /api/letter-header): name, sign-off name, email, phone, location, and up to 6 links; until saved it comes
from config.candidate (tools/letter-header.ts fromCandidate), and every letter document reads it through letterHeader.
headerLines (shared by Word, PDF, and the Google Doc) puts email, phone, and location on one line and the links as many
to a line as fit; each email or web address is a clickable link (PDF link annotations). Every document's text goes through tools/text.ts withoutPictographs (emoji show as pictures in Word and "?"
in a PDF), and discovery and manual add save titles and companies without them. test/letter-header.test.js.
Letter fact check (v3 Phase 1; agents/hunt/verify-letter.ts, prompt verify-letter with agents/hunt/schemas/verify-letter.json,
VERIFY_MODEL, Haiku 4.5 from the letter eval): each claim a letter makes about the candidate, supported, unsupported, or contradicted by the
knowledge doc plus the job's resume (system); the posting is data. letter_checks (022, a user table) holds one row per
version (agents/letter-checks.ts: claims_json with dismissed flags; failed = could not run). generateForPostings checks
each letter it writes on the same trace; the panel checks a version after a save (POST /api/postings/:id/letters/:versionId/check,
CHECKS_PER_DAY) and dismisses claims (.../claims/:index/dismiss); restore copies the check. It never blocks a letter, a
save, or a download; logs hold counts only. The demo seeds SAMPLE_CHECK_CLAIMS and answers Check again with sampleCheck.
test/verify-letter.test.js, test/letter-check-routes.test.js.
Meeting prep (agents/hunt/prep.ts, server/prep-routes.ts, Prepare for a meeting in the job panel): Opus 5.5 at high effort,
streamed, with server-side refusal fallbacks; with research on it uses web_search_20260209 (max 15) and web_fetch (max 5).
Input is the people (name, role, firm, link, what the user knows), meeting kind, format, time, and free context, plus the
knowledge doc, posting, analysis, latest letter, and notes. The document is the Markdown after the last tool block, saved
in meeting_preps (UUID keys) and as a Google Doc in "Job Agent Meeting Prep". About $1 to $2 each; logs hold counts only.

## Scoring
Default model and promotion threshold live in agents/discovery/score.ts with the eval evidence behind them.
Change the prompt, schema, model, or threshold only after rerunning the scoring eval and comparing pairwise accuracy.
Never kept (tools/listings.ts): list-of-jobs pages and search.excludedSites links; discovery and manual add drop them, scoring gives 1.
Job sites to skip (agents/excluded-sites.ts, server/excluded-sites-routes.ts, Settings and Skip this site under the job panel's
link): each user's own list with a note per site in user_settings; configFor adds it to search.excludedSites (the owner's
file entries stay, shown as from the file), so scripts read config through configFor(store.raw, OWNER_ID, loadConfig()).
Saved jobs from a site are removed only on request (archiveSiteJobs; never one applied to). test/excluded-sites.test.js.
Without posting text a score is capped at 5 (analysis.uncappedScore keeps the original) and the job is never promoted; the UI flags 7+ ones.
The job panel's score details (server/queries.ts scoreDetails) say when, by which model, from text or title, and with
which prompt (agents/prompts.ts describeVersion matches the stored version hash: default, a saved edit, or earlier).
Sonnet 5.5 and Opus 5.5 always think: keep effort low and maxTokens generous for scoring (MODEL_SETTINGS).
Scripts that need secrets load .env through node --env-file.

## TypeScript (v3 Phase 2, decision 0002)
Every new file is TypeScript (.ts, .tsx on the page; web/src is all TypeScript, with Vite's module types from web/src/vite-env.d.ts).
Node 22.18 or newer runs .ts files by stripping their types, so there is
no build step for the server: only erasable syntax (no enums, parameter properties, or decorators; tsconfig erasableSyntaxOnly),
imports name the .ts file, and type-only imports use import type. Typecheck and lint run in CI and fail it.
`void call()` marks a deliberate fire-and-forget call whose function catches its own errors; a lint finding that is a real
bug is fixed as a bug, never hidden. Each any or @ts-expect-error has its reason beside it. types/agent-core.d.ts types the
agent-core exports until Agent-Core ships its own; keep it in step on an upgrade.
Routes type their request with Fastify's generics (app.post<{ Params: IdParams; Body: {...} }>, matching the JSON schema);
server/types.ts holds App, RouteServices, StartTask, Notices, and declares req.uid, user, account, role, and timeZone. Query
results are cast to db/types.ts rows. server/index.js is a one-line launcher for server/main.ts (npm run ui, the Dockerfile,
and compose.yml run index.js); buildApp's options and services are BuildAppOptions and AppServices in server/app.ts.
scripts, evals, and test stay JavaScript (deploy.sh, compose.yml, the Windows tasks, and the server run scripts/*.js by name),
typed with JSDoc (@param, @typedef, /** @import { X } from '...' */, casts as /** @type {T} */ (x)) and checked by the
root tsconfig.json (checkJs: true), so a new .js file there is checked too. Tests build stand-ins through test/fixtures/fakes.js.
The any count and each reason are in docs/v3/PLAN.md (Phase 2); a new any updates that table.

## Portability (Windows now, a Linux server later)
Calendar days come from tools/dates.ts localDay/localDaysAgo/dayOf, in TZ from .env; never take "today" from toISOString(),
which is UTC (10 PM Eastern is already tomorrow). Timestamps stay ISO UTC.
Personal data paths come from tools/paths.ts dataPath(...) (DATA_DIR, default the repo's data folder); never repoPath('data', ...).
CI (.github/workflows/ci.yml) runs npm audit (production, high), npm test in America/Los_Angeles and UTC, the web build, and the personal-data scan.

## Cloud
Dockerfile: node:22-bookworm-slim, production node_modules and Playwright Chromium in early layers (cached until
package-lock.json changes), code and web/dist last; runs as node (uid 1000) with DATA_DIR=/data, HOST=0.0.0.0.
.dockerignore keeps .env, data/, and credentials out of the image; keep it in step with .gitignore.
deploy/ is copied to the server's /opt/job-agent: compose.yml (app, demo, and Caddy, only Caddy publishes ports; it fixes
DATA_DIR, HOST, PORT, TRUST_PROXY=1; demo gets no env_file), Caddyfile (no access log), deploy.sh (deploy <tag> | rollback | up | status; healthy means app and demo both answer /healthz;
the GitHub deploy key's authorized_keys line forces it, so it validates SSH_ORIGINAL_COMMAND), cloud.env.example.
.github/workflows/deploy.yml runs after CI succeeds on a push to main: build, publish ghcr.io/<owner>/job-agent
(sha-<7> and latest), then deploy over SSH when the DEPLOY_ENABLED variable is true. GitHub holds only the deploy
host, user, key, and known_hosts; app secrets live in the server's .env. A new required setting needs a line in
deploy/cloud.env.example.

## Demo
AUTH_MODE=demo (server/auth.ts): no sign-in; every non-read request gets 403 except POST /api/prompts/:name/preview,
which writes nothing; server/main.ts starts with demo services (no Google auth, Claude, browser, or schedule) and replays
demo/sample-data.ts SAMPLE_TASKS on the Activity tab; a per-address cap on all requests (DEMO_REQUEST_LIMIT). The UI shows every
control: web/src/api.ts (setDemoMode from /api/me) stops every non-GET request before it is sent (prompt preview aside),
rejects with DEMO_NOT_SAVED, and fires demo-blocked, which DemoNotice (web/src/demo.tsx) shows; the server's refusal is
what protects it. Only Open posting (sample links) and the admin pages stay hidden.
The demo's /api/me names the sample candidate (DEMO_EMAIL, an example.com address) so the header reads like production's.
Demo Settings shows the sample candidate's About you and search, editable but never saved (DEMO_ABOUT_YOU and DEMO_CONFIG, served by
server/account-routes.ts in demo mode; nothing stored). A sample watch-out about location comes only from that job's workplace.
scripts/demo-seed.js builds the sample database (marked with the demo_database setting; it refuses any other database,
checked read-only) from demo/sample-data.ts; sample prompt edits are the repo defaults plus one line (PROMPT_EDITS) and must
validate. Sample data is invented and on example.com domains; never copy the user's data, wording, or history into it.
npm run demo previews it locally (demo-data/, gitignored); test/demo.test.js walks every route to prove it is read-only.
A new route that changes data is refused in the demo automatically; a new read route must not call an outside service.
The demo never calls Claude (no client, no key). Its AI actions answer with canned samples in the real response shapes,
labeled as samples and never saved: demo/samples.ts (prep, letter, tweaks, re-score, revision, Help answer, draft; loaded
by api.ts only in the demo, its own chunk) through local stand-in tasks, and Find someone to contact from the demo-only
GET /api/postings/:id/find-contact/sample (demoContactResult). test/demo-samples.test.js holds them to the real rules.
Demo usage counts (optional): DEMO_POSTHOG_KEY/HOST on the demo container only (server/demo-analytics.ts returns null outside
AUTH_MODE=demo); /api/me hands them to the page and the CSP's connect-src adds that host. web/src/analytics.ts sends
to PostHog's capture endpoint itself (no SDK, cookies, storage, referrer, or URLs): fixed event names and property values
from its lists only, anything else dropped; never text, job details, or paths; nothing at all when the browser sends
Global Privacy Control. demo_opened carries source (SOURCES: trafficSource reads a listed utm_source or the referrer's
host in the browser; the URL, referrer, and utm text are never sent); the personal site is the parent domain of the
demo's PUBLIC_URL (DEMO_SITE_ADDRESS), never written in the repo. A new event goes on its EVENTS list and in PRIVACY.md's demo section. The demo banner links
/privacy. test/demo-analytics.test.js.
Usage (Admin > Usage, web/src/components/UsageAdmin.tsx; GET /api/admin/usage?weeks=4..52, ADMIN_ONLY, never in the
demo): server/admin-queries.ts usageByWeek gives one row per Sunday to Saturday week in the app's zone (never the asking
admin's own), newest first, the first being this week so far: weekEnding, accounts seen (this week: users.last_seen_at;
earlier weeks: distinct users with a run or added job), pipeline runs completed (ok, partial) and failed, jobs added,
letters (v2, v2-revision, user), preps, Claude spend (run_calls.cost_usd, priced calls only), and feedback received.
The response schema allows those fields only. Tiles show the latest full week; bar charts carry .sr-only tables. Totals
only, kept in the app: nothing logged, emailed, or sent to any analytics service. test/usage.test.js.
Usage totals (server/usage-totals.ts, usage_totals from 020 and 021, AUTH_MODE=google only): per app day (tools/dates.ts appDay),
visits by device (phone, tablet, computer from the user agent), by browser and major version (browserOf: a fixed
name and a number, "Chrome 130", or Other), and by location ("City, State, Country" or unknown, from
req.ip in the local DB-IP City Lite file, server/geo.ts openGeo), once per account a day (an in-memory set, never stored);
a visit is a signed-in Mozilla/ browser's successful / or /api/* request. Arrivals by source (linkedin, github, site, demo,
other, direct): document loads of / and of /auth/login without next; Google sign-in returns and own-origin referrers are
not counted; SOURCE_SITE_HOST and SOURCE_DEMO_HOST name site and demo. The table has day, dimension, value, count only:
never an address, user agent, referrer, URL, or user id, and no link between dimensions. It is not a user table, so
export and deletion leave it. GET /api/admin/usage returns { weeks, devices, browsers, locations, sources } for the period.
test/usage-totals.test.js.
PRIVACY.md must stay true of the code: a new outside service, admin column, or demo event changes its wording.

## Spending and internet safety
Make Claude clients only with tools/claude.ts createJobClaude(db). Each call is paid by the user it runs as: the owner, and
users the owner put on their key (users.ai_source 'owner'), use ANTHROPIC_API_KEY; anyone else their own key, saved in
Settings (server/account-routes.ts: checked with Anthropic's free model list, sealed by tools/secret-box.ts with USER_KEY_SECRET
and the user id, never returned, logged, or shown, even to the admin). No key, no AI (NoClaudeKeyError). Caps (agents/budget.ts
checkBudget, from run_calls joined to runs.user_id): everything on the owner's key against the owner's cap (Admin > Spending,
else MONTHLY_CLAUDE_BUDGET_USD, else $50), and each user on it against their own monthly cap (Admin > Users); the first
refusal of a month emails that user and the owner. Every Claude call must pass a trace (a createJobTracer run) so its cost
lands in run_calls with its user, or the caps cannot see it.
server/security.ts: security headers on every response (strict CSP: scripts only from 'self'; a route that sets its own CSP keeps
it), rate limits in google mode (sign-in 30 per 15 minutes per address; 100 refused requests blocks the address for the window;
TRUST_PROXY behind a proxy), and errorReply (5xx bodies are generic; details go to the server log, never request bodies).
test/security.test.js walks app.routeList: a new route is covered automatically and must need sign-in unless it is /auth/* or /healthz.
US-only access (server/geo.ts, GEO_ALLOW; the app only, never the demo): the country comes from Apple's iCloud Private Relay list
(/app/geo/relay.csv, downloaded at build time) first, then DB-IP; unknown addresses pass, no DB-IP file fails open, a missing
relay list keeps blocking on and alerts the owner (geo-relay). test/geo.test.js, documentation addresses only.

## Inbox
Pre-filter first: only threads the user started, known contacts, known company domains, and config/inbox.json atsDomains;
nothing about other mail is stored. Every pre-filtered email is classified (prompt inbox-classify, version stored on each email).
Rule matches count as certain; model links need confidence >= autoLinkAt (0.85), otherwise needs_review. Status only moves
forward automatically (actions.js planStatus); backward or reopening moves go to review. An email with instructions aimed at an
AI (classify.js looksLikeInjection) is held for review with no action even when a rule links it. Bodies are stored only for
linked emails, AES-256-GCM with EMAIL_ENC_KEY. Every change goes to decision_log with the Gmail message ID, rule or model, and
prompt version. The Gmail wrapper only reads and adds labels; never add send, delete, archive, or remove-label calls.
New inbox tables use UUID text keys, ISO UTC text timestamps, and portable types (PostgreSQL later).

## Hard rules
This repo is public. Never commit personal data: names, locations, employers, emails, Google IDs, job history, or API keys.
Personal values live only in .env, data/config/job-search.json, and data/job-agent.db. Prompts use placeholders such as {{candidateName}}.
Never print knowledge doc content or prompt/response text in logs or script output; counts and metadata only.
(The exceptions are npm run inbox:review and the local Inbox screen, which show the user an email's subject and summary.)
The only copy of personal data that leaves the machine is the encrypted backup (tools/backup, the same design as
Health-Review): an online SQLite snapshot that must pass its integrity check, packed with the settings and attachments,
gzipped, then AES-256-GCM with a scrypt key from JOB_BACKUP_PASSPHRASE (.env only, never uploaded or logged) and a fresh
salt and nonce per file, verified by decrypting before upload with the drive.file scope. Plaintext snapshots live only in
the OS temp folder. Never back up .env or data/google. Kept: 7 nightly, 3 weekly, 1 monthly.
SUPPORT_EMAIL (tools/support.ts) is the published help address: Settings, Help ({{supportContact}} in help/*.md, PRIVACY.md,
TERMS.md), the sign-in pages, the demo banner, /api/me. It is configuration, never written in the repo.
Email goes only to the owner (the run report, failure alerts, access requests) and to a person about their own account
(approved, not approved, paused, allowance reached), through server/notices.ts, which picks each recipient itself: names,
addresses, and links only, never job data. Never send anything else, or to anyone else.
Run npm install from PowerShell, never WSL: node_modules holds Windows builds of native modules (better-sqlite3).
Output JSON schemas must avoid minimum/maximum/minLength/maxLength and complex array constraints (the API rejects them); use enum or validate in code.
