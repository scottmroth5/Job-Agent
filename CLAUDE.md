## Purpose
Job Discovery and Job Hunt agents built on the shared agent-core package.
agent-core comes from the public Agent-Core repo as a git dependency pinned to a version tag
("@scottmroth5/agent-core": "github:scottmroth5/Agent-Core#semver:^0.2.0"). Upgrade with npm install "github:scottmroth5/Agent-Core#semver:^<x.y.z>"; test unreleased changes with npm link ../Agent-Core.
Job specific logic stays in this repo; never add it to agent-core.

## Structure
/agents/discovery   finds, researches, and scores postings: sources/ (one module per job source, parse functions exported for tests),
                    details.js (full text: source, LinkedIn guest endpoint, JSON-LD, page text, browser), discover.js (one run),
                    prompts/*.md templates, schemas/*.json output schemas
/agents/hunt        cover letters, resume tailoring, application tracking
/tools              job specific helpers: config, urls, dates, template, google (auth, docs, gmail)
/db                 SQLite schema (migrations/*.sql plus code migrations listed in db/index.js, applied in id order), openJobStore, v1 import.
                    Never rebuild postings in a migration: migrations run in a transaction with foreign keys on, so a drop cascades.
                    008 shows the safe way to loosen a CHECK constraint (writable_schema). Back up data/job-agent.db before schema changes
/scripts            command-line entry points (see Commands)
/config             job-search.example.json: the shape of the real, gitignored data/config/job-search.json
/server             Fastify API over the SQLite store (app.js routes, queries.js, tasks.js, auth.js); serves the built UI
/agents/manual.js   manually added jobs: dedupe, fetch or paste text, score, write materials
/agents/inbox       Gmail inbox: sync.js (historyId cursor, 7-day fallback), prefilter.js, match.js (thread, contact, domain,
                    ATS subject), classify.js (Haiku, fixed untrusted-email system prompt), actions.js (gate, forward-only status),
                    process.js (one run; decideEmail is shared with the eval), review.js. Settings: config/inbox.json
/agents/identity.js same-job matching: companyTitleKey (tools/urls.js) spells out VP/Sr/CTO, drops "of/and/remote" and company suffixes;
                    placeholder companies ("See posting") are read from the Google title. Rule changes need npm run cleanup to rekey
/web                React (Vite) UI: job table with track/stage/status filters, detail panel, add-job dialog, fractional stacking bar
/evals              eval runner and rubric code; real eval cases live in data/evals; evals/inbox/cases.json is synthetic. Results: EVALS.md
/test               node:test suites with synthetic fixtures only
/data               gitignored: job-agent.db, config/, google/ (OAuth client and token), v1-export/
/legacy contains the v1 scripts for reference only. Do not modify or import from them.

## Commands
npm test                          run all unit tests (no network, no real data)
node --test test/db.test.js       run one suite
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
npm run hunt                      resume tweaks + cover letters (Google Docs) for promoted jobs (-- --dry-run, --ids, --regenerate, --no-docs)
npm run archive -- --dry-run      preview archiving; without --dry-run it moves them
npm run cleanup -- --dry-run      after a rule change: rekey duplicates, archive list-of-jobs pages, search.excludedSites jobs, and duplicate copies (the acted-on copy is kept);
                                  move pipeline jobs without a description back to Discovered. Its status changes are changed_by agent, which the eval ignores
npm run report                    email the report for the last 24 hours (-- --hours=N, --no-email)
npm run pipeline                  discover, score, hunt, archive, then one report email (the scheduler's entry point)
npm run ui                        build the React UI and start the server at http://localhost:5178 (API contract: /api/openapi.json)
npm run web:dev                   Vite dev server with hot reload on :5179, forwarding /api to a running npm run ui
npm run add -- --url=...          add a job by hand (also --description-file, --title, --company, --track, --rate, --hours, --write-materials)
npm run inbox:auth                one-time Gmail sign-in (gmail.readonly + gmail.modify); writes GMAIL_REFRESH_TOKEN and EMAIL_ENC_KEY to .env
npm run inbox                     process new Gmail since the stored historyId (inbox:backfill -- --days=N --dry-run for history)
npm run inbox:review              resolve needs_review emails; each choice becomes a case in data/evals/inbox/review-cases.jsonl
npm run evals                     inbox eval (about $0.06); -- --all adds the scoring eval. Record results in EVALS.md

## UI and API
server/app.js holds every route with a JSON schema; keep /api/openapi.json the source of truth for the UI.
The Run pipeline button (server/pipeline-routes.js) spawns scripts/pipeline.js as its own process and turns its "[pipeline] Step"
lines into task progress; the last run comes from the runs table. The Inbox screen (#/inbox, server/inbox-routes.js) checks
Gmail in-process, resolves needs_review emails with agents/inbox/review.js, and closes reminders.
Every task keeps its output (server/tasks.js: steps plus log lines; pass the task's logger to createTracer so run logs land there);
the Activity tab (#/activity/<taskId>) shows it live via GET /api/tasks/:id/log?from=N. Output is job titles and counts, never email content.
Long actions (add, score, write-materials, regenerate, refetch) run as in-memory tasks the UI polls; they refuse to start
while a pipeline step is running. AUTH_MODE=none binds to 127.0.0.1 only; exposing the server requires adding a login mode
in server/auth.js first. web/dist is build output (gitignored).

## Prompts
agents/prompts.js is the single way to load a prompt: getPrompt(db, name) returns the admin-screen edit if one is active
(prompt_versions table, with history), else the repo file, which stays the default. The UI's Admin screen (#/admin) edits
the four templates; placeholders are validated on save, and output schemas stay read-only in the repo because code reads
their fields. Personal wording belongs in edits or the knowledge doc, never in the repo defaults.

## Tracks
Postings are fulltime or fractional (tools/track.js). Fractional postings score with prompts/score-fractional.md, which adds
fit (High/Medium/Stretch/Poor), why it fits, caveats, pay and hours; annualized estimates use tools/rates.js (tracker math).
Go Fractional is bot-protected: it is never scraped, and search.siteSearch stays false unless the Serper plan allows site: queries.

## Hunt
Letters: Sonnet 5.5 at medium effort; v1's cleanup (strip greeting/sign-off, no dashes) and config.coverLetterChecks run in code,
plus a word-limit flag. Letter Docs go to the app's own "Job Agent Cover Letters" Drive folder (drive.file scope).
Nothing is overwritten: --regenerate creates new artifacts and Docs. Report HTML escapes every value.

## Scoring
Default model and promotion threshold live in agents/discovery/score.js with the eval evidence behind them.
Change the prompt, schema, model, or threshold only after rerunning the scoring eval and comparing pairwise accuracy.
Never kept (tools/listings.js): list-of-jobs pages and search.excludedSites links; discovery and manual add drop them, scoring gives 1.
Without posting text a score is capped at 5 (analysis.uncappedScore keeps the original) and the job is never promoted; the UI flags 7+ ones.
Sonnet 5.5 and Opus 5.5 always think: keep effort low and maxTokens generous for scoring (MODEL_SETTINGS).
Scripts that need secrets load .env through node --env-file.

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
Never send email to anyone but the user; the run report to the user's own address is the only email the app sends.
Run npm install from PowerShell, never WSL: node_modules holds Windows builds of native modules (better-sqlite3).
Output JSON schemas must avoid minimum/maximum/minLength/maxLength and complex array constraints (the API rejects them); use enum or validate in code.
