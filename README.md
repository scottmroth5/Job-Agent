# Job Agent

An AI job-search assistant that finds postings, scores them against your background with Claude, and drafts tailored resume tweaks and cover letters for the best matches. It runs on your own computer, keeps your data local, and gives you a small web page to review and track everything.

## What it does

- **Finds jobs** from Himalayas, RemoteOK, Fractional Jobs, LinkedIn (remote and near you), and Google results; skips ones it has already seen; fetches the full posting text.
- **Checks location** against where you can work, before any AI call, so an on-site role in the wrong city never scores high.
- **Scores every job 1 to 10** with Claude against a Google Doc you write about yourself. Fractional roles also get a High / Medium / Stretch fit, pay, hours, and an annualized estimate.
- **Writes materials** for jobs scoring 7 or higher: resume tweaks, and a cover letter saved as a Google Doc, with rule checks that flag letters for review.
- **Emails a summary** of each run, including its cost.
- **Reads your job email** (optional): matches confirmations, rejections, interview requests, assessments, and offers in Gmail to your applications, moves their status forward, records funnel dates, and labels the threads `Job/<Company>`. It never sends, deletes, or archives mail.
- **Web page** (local only) to filter jobs, open application links and letters, track status, add jobs you find yourself, run the pipeline, review job email on an Inbox screen, and edit the prompts Claude follows.

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
| `npm run cleanup` | Remove list-of-jobs pages, excluded-site jobs, and duplicate copies; move jobs without a description back to Discovered (`-- --dry-run` to preview) |
| `npm run report` | Email the summary for the last 24 hours |
| `npm run inbox:auth` | One-time Gmail sign-in for the inbox |
| `npm run inbox` | Check Gmail for new job email once |
| `npm run inbox:backfill` | Process the last 180 days of job email (`-- --days=30 --dry-run` to preview the count and cost) |
| `npm run inbox:review` | Confirm, reassign, or dismiss emails the inbox was unsure about (also on the web page's Inbox screen) |
| `npm run evals` | Run the inbox eval (`-- --all` adds the scoring eval; both cost money) |
| `npm run eval:score` | Compare scoring models on jobs you applied to vs. passed on (costs money) |
| `npm test` | Run the tests (no network or keys needed) |

## Gmail inbox setup (optional)

The inbox uses the same Google Cloud project and OAuth client as the rest of the app, with its own
sign-in. It asks for two permissions: read mail, and modify (used only to add labels).

**If you already set up Google for Job Agent** (the setup guide), the project, desktop client, and
production publishing are already done. In [Google Cloud](https://console.cloud.google.com), with the
Job Agent project selected:

1. **Enable the Gmail API:** APIs & Services, Library, "Gmail API", Enable.
2. **Add the scopes:** Google Auth Platform, Data Access, Add or remove scopes. Add `gmail.readonly` and `gmail.modify`, then Save.
3. **Sign in:** `npm run inbox:auth`, and leave both boxes checked. This saves `GMAIL_REFRESH_TOKEN` to `.env`, and creates `EMAIL_ENC_KEY` there if it's missing. Neither is printed. **Back up `.env`:** stored email bodies cannot be read without that key.
4. **Preview, then run:** `npm run inbox:backfill -- --days=30 --dry-run` shows how many emails would be classified and the cost (about $0.002 each with Claude Haiku). Then run `npm run inbox:backfill` once, and `npm run inbox` after that.

**If you are starting without a Google setup,** do these first, then steps 1 to 4 above:

- **Create a Google Cloud project** at [console.cloud.google.com](https://console.cloud.google.com).
- **Configure the OAuth consent screen** (Google Auth Platform): user type External, and add yourself as a test user.
- **Create desktop credentials:** Clients, Create client, application type **Desktop app**. Either download the JSON to `data/google/client_secret.json`, or put the ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- **Publish the app to production:** Audience, Publish app. In testing mode, Google expires refresh tokens after 7 days, so the inbox would stop working every week. As an unverified app for your own account, Google shows an "unverified app" warning at sign-in: choose Advanced, then continue. Verification is not needed for personal use.

Only email that looks job related is processed: threads you started, known contacts, known company
domains, and job sites (`config/inbox.json`). Nothing about other mail is stored. Email bodies are
stored, encrypted (AES-256-GCM), only for emails linked to an application. Status only ever moves
forward automatically; anything else waits for `npm run inbox:review`.

## Privacy

Everything personal stays on your machine: your settings (`data/config`), Google sign-in (`data/google`), the job database (`data/job-agent.db`), and API keys (`.env`). The `data` folder and `.env` are excluded from Git, and a pre-commit guard (`npm run hooks:install`) blocks commits that contain any of your private terms, API key values, or files from those locations. Prompts in the repo are generic; personal facts belong in your Google Doc.

Job sites have their own terms of use. The agent reads public listings at a polite pace, backs off when rate limited, and does not try to get around sites that block automated access; for those, paste the description through the web page instead.

## Project layout

| Path | Contents |
|---|---|
| `agents/discovery` | Job sources, full-text fetching, location checks, scoring, and scoring prompts |
| `agents/hunt` | Resume tweaks, cover letters, the report email, and archiving |
| `agents/manual.js` | Adding jobs by hand |
| `agents/inbox` | Gmail inbox: pre-filter, matching, classification, status actions, review |
| `server/` | Local API (OpenAPI spec at `/api/openapi.json`) |
| `web/` | React web page |
| `db/` | SQLite schema and migrations |
| `evals/` | Scoring evaluation |
| `tools/` | Shared helpers: config, HTTP, Google, location, rates |
| `docs/` | Setup and user guide |

Built with Node.js, SQLite, Fastify, React, and Claude via [agent-core](https://github.com/scottmroth5/Agent-Core), a small shared library for the Claude client, run tracing, and storage.
