## Purpose
Job Discovery and Job Hunt agents built on the shared agent-core package.
agent-core comes from the public Agent-Core repo as a git dependency pinned to a version tag
("@scottmroth5/agent-core": "github:scottmroth5/Agent-Core#semver:^0.2.0"). Upgrade with npm install "github:scottmroth5/Agent-Core#semver:^<x.y.z>"; test unreleased changes with npm link ../Agent-Core.
Job specific logic stays in this repo; never add it to agent-core.

## Structure
/agents/discovery   finds, researches, and scores postings (prompts/*.md templates, schemas/*.json output schemas)
/agents/hunt        cover letters, resume tailoring, application tracking
/tools              job specific helpers: config, urls, dates, template, google (auth, docs, gmail)
/db                 SQLite schema (migrations/*.sql, applied in file-name order), openJobStore, v1 import
/scripts            command-line entry points (see Commands)
/config             job-search.example.json: the shape of the real, gitignored data/config/job-search.json
/server             API over the SQLite store, plus the in-process scheduler that runs the agents
/web                React (Vite) UI; the only place the user reviews and edits the pipeline
/evals              eval runner and rubric code; real eval cases live in data/evals
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
Scripts that need secrets load .env through node --env-file.

## Hard rules
This repo is public. Never commit personal data: names, locations, employers, emails, Google IDs, job history, or API keys.
Personal values live only in .env, data/config/job-search.json, and data/job-agent.db. Prompts use placeholders such as {{candidateName}}.
Never print knowledge doc content or prompt/response text in logs or script output; counts and metadata only.
Output JSON schemas must avoid minimum/maximum/minLength/maxLength and complex array constraints (the API rejects them); use enum or validate in code.
