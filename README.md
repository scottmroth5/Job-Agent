# Job Agent

An AI job-search assistant that finds postings, scores them against your background with Claude, and drafts tailored resume tweaks and cover letters for the best matches. It runs on your own computer, keeps your data local, and gives you a small web page to review and track everything.

## What it does

- **Finds jobs** from Himalayas, RemoteOK, Fractional Jobs, LinkedIn (remote and near you), and Google results; skips ones it has already seen; fetches the full posting text.
- **Checks location** against where you can work, before any AI call, so an on-site role in the wrong city never scores high.
- **Scores every job 1 to 10** with Claude against a Google Doc you write about yourself. Fractional roles also get a High / Medium / Stretch fit, pay, hours, and an annualized estimate.
- **Writes materials** for jobs scoring 7 or higher: resume tweaks, and a cover letter saved as a Google Doc, with rule checks that flag letters for review.
- **Emails a summary** of each run, including its cost.
- **Web page** (local only) to filter jobs, open application links and letters, track status, add jobs you find yourself, and edit the prompts Claude follows.

## How it works

```
discover ─► score ─► promote (7+) ─► write materials ─► archive ─► email report
   │          │                            │
 sources    Claude                   Google Docs
 + dedupe   (your knowledge doc)     (cover letters)
```

`npm run pipeline` runs every step. Each step can also run on its own, and every run records its Claude token use and cost.

## Getting started

**Full step-by-step instructions: [docs/Job-Agent-Setup-Guide.docx](docs/Job-Agent-Setup-Guide.docx)** (Word, about 9 pages).

In short, you need:

- Node.js 22+ and Git (on Windows, use PowerShell rather than WSL)
- An [Anthropic API](https://console.anthropic.com) key (typically a few dollars a week)
- A [Serper.dev](https://serper.dev) key (the free tier is enough)
- A Google account, with a small Google Cloud app for Docs, Drive, and Gmail access
- A Google Doc describing your background and job targets

```bash
git clone https://github.com/scottmroth5/Job-Agent.git
cd Job-Agent
npm install
# create .env with your keys and settings, then:
npm run google:login          # one-time Google sign-in
npm run discover -- --dry-run --limit=20
npm run pipeline              # find, score, and write materials
npm run ui                    # open http://localhost:5178
```

Your settings go in `data/config/job-search.json`; start from [`config/job-search.example.json`](config/job-search.example.json).

## Commands

| Command | What it does |
|---|---|
| `npm run pipeline` | Discover, score, write materials, archive, and email a report |
| `npm run ui` | Start the web page at http://localhost:5178 |
| `npm run discover` | Only find and store new jobs (`-- --dry-run` to preview) |
| `npm run score` | Only score new jobs and promote 7+ (`-- --dry-run` for a cost estimate) |
| `npm run hunt` | Only write resume tweaks and cover letters for promoted jobs |
| `npm run add -- --url=...` | Add a job you found yourself |
| `npm run cleanup` | Remove list-of-jobs pages and excluded-site jobs; move jobs without a description back to Discovered (`-- --dry-run` to preview) |
| `npm run report` | Email the summary for the last 24 hours |
| `npm run eval:score` | Compare scoring models on jobs you applied to vs. passed on (costs money) |
| `npm test` | Run the tests (no network or keys needed) |

## Privacy

Everything personal stays on your machine: your settings (`data/config`), Google sign-in (`data/google`), the job database (`data/job-agent.db`), and API keys (`.env`). The `data` folder and `.env` are excluded from Git, and a pre-commit guard (`npm run hooks:install`) blocks commits that contain any of your private terms, API key values, or files from those locations. Prompts in the repo are generic; personal facts belong in your Google Doc.

Job sites have their own terms of use. The agent reads public listings at a polite pace, backs off when rate limited, and does not try to get around sites that block automated access; for those, paste the description through the web page instead.

## Project layout

| Path | Contents |
|---|---|
| `agents/discovery` | Job sources, full-text fetching, location checks, scoring, and scoring prompts |
| `agents/hunt` | Resume tweaks, cover letters, the report email, and archiving |
| `agents/manual.js` | Adding jobs by hand |
| `server/` | Local API (OpenAPI spec at `/api/openapi.json`) |
| `web/` | React web page |
| `db/` | SQLite schema and migrations |
| `evals/` | Scoring evaluation |
| `tools/` | Shared helpers: config, HTTP, Google, location, rates |
| `docs/` | Setup and user guide |

Built with Node.js, SQLite, Fastify, React, and Claude via [agent-core](https://github.com/scottmroth5/Agent-Core), a small shared library for the Claude client, run tracing, and storage.
