# Job Agent

An AI job-search assistant that finds postings, scores them against your background with Claude, and drafts tailored resume tweaks and cover letters for the best matches. It runs on your own computer, keeps your data local, and gives you a small web page to review and track everything.

## What it does

- **Finds jobs** from Himalayas, RemoteOK, Fractional Jobs, LinkedIn (remote and near you), and Google results; skips ones it has already seen; fetches the full posting text.
- **Checks location** against where you can work, before any AI call, so an on-site role in the wrong city never scores high.
- **Scores every job 1 to 10** with Claude against a Google Doc you write about yourself. Fractional roles also get a High / Medium / Stretch fit, pay, hours, and an annualized estimate.
- **Writes materials** for jobs scoring 7 or higher: resume tweaks, and a cover letter saved as a Google Doc, with rule checks that flag letters for review.
- **Preps you for meetings**: from a job's panel, **Prepare for a meeting** asks who the meeting is with (one person or a group) and anything else to know, researches the people and company online, and writes a prep document (who they are, company snapshot, your opening, fit table, stories, likely questions, gaps, questions to ask, and close). It appears in the app and as a Google Doc. Claude Opus 5.5, about $1 to $2 each.
- **Emails a summary** of each run, including its cost.
- **Reads your job email** (optional): matches confirmations, rejections, interview requests, assessments, and offers in Gmail to your applications, moves their status forward, records funnel dates, and labels the threads `Job/<Company>`. It never sends, deletes, or archives mail.
- **Web page** (local only) to filter jobs, open application links and letters, track status, keep dated notes, each formatted (bold, italics, bullets, links) and editable, attach files to a job (a tailored resume, an offer letter; 25 MB each), add jobs you find yourself, run the pipeline, review job email on an Inbox screen, edit the prompts Claude follows, and add or archive your own statuses, stages, and tracks (Admin > Lists).

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
| `scripts\register-server-task.ps1` | Start the web page automatically when you sign in to Windows, hidden, restarting if it crashes. Then `npm run server:restart` after code changes and `npm run server:stop` to stop it. Logs in `data\logs\server.log` |
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
| `scripts\register-schedule.ps1` | Run the pipeline and inbox automatically (default Monday and Thursday at 6:00 AM; `-Time`, `-Days`, `-Remove`). Logs in `data\logs` |
| `npm run evals` | Run the inbox eval (`-- --all` adds the scoring eval; both cost money) |
| `npm run eval:score` | Compare scoring models on jobs you applied to vs. passed on (costs money) |
| `npm test` | Run the tests (no network or keys needed). GitHub runs them on every push, in a US time zone and in UTC |

## Settings in .env

Besides API keys and sign-in values, these settings change how the app runs. The same settings work on your computer and on a cloud server.

| Setting | Example | What it does |
|---|---|---|
| `TZ` | `America/Chicago` | Your time zone. Dates like "applied on" and "today" use it, and scheduled times are in it. Set it: a cloud server runs on UTC, where 10 PM Eastern is already tomorrow. |
| `SCHEDULE_PIPELINE` | `Mon,Thu 06:00` | Run the pipeline from the server at these times, then check the inbox when Gmail is set up. |
| `SCHEDULE_INBOX` | `daily 12:00` | An extra inbox check. |
| `SCHEDULE_BACKUP` | `daily 23:00` | The encrypted backup. |
| `DATA_DIR` | `/data` | Where the database, settings, Google sign-in, attachments, and logs live. Defaults to the repo's `data` folder. |
| `MONTHLY_CLAUDE_BUDGET_USD` | `50` | The monthly Claude spending cap, until you set one on **Admin > Spending** (which wins). Default $50. When this calendar month's spend reaches it, Claude calls stop until the 1st; the rest of the app keeps working. The Home page shows spend against the cap. |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Only behind a reverse proxy (for example Caddy in the cloud): which proxy addresses to trust for the visitor's address, so rate limits count real visitors. Name the proxy's addresses (as here, for a proxy on a private network); never a hop count like `1`, which makes the app see the proxy as every visitor. |
| `SUPPORT_EMAIL` | `support@example.com` | Where people write for help: shown on Settings, Help, the sign-in pages, the demo banner, and in the privacy policy and terms. Unset, those places point to Send feedback instead. In the cloud, the demo reads it from the same `.env` (compose.yml). |
| `GEO_ALLOW` | `US` | Only these countries (two-letter codes, comma separated) may use the site; everyone else gets a short page saying it is US only. The health check always works, and nothing is blocked when unset or when the country database is missing. The server image includes the database (IP to Country Lite by DB-IP, CC BY 4.0), refreshed weekly. |

Once the app is on the internet (Google sign-in on), it also sends security headers on every page (a strict content security policy, no framing, HTTPS-only when `PUBLIC_URL` is https), limits sign-in attempts to 30 per address per 15 minutes, turns away an address after 100 refused requests in 15 minutes, and answers server errors with a plain message (details go to the server log only). A test checks that every page and API route needs sign-in.

Schedules are days (`daily`, `weekdays`, `weekends`, or names like `Mon,Thu`) and a 24-hour time; join several with `|` for different times on different days (`Mon,Thu 06:00 | Sat 09:00`). If a scheduled job fails, the app emails you at `EMAIL_ADDRESS` (at most once a day per job, and again only after it has worked). They run while the server runs; a run missed while the server was off or asleep runs when it comes back, if it was missed within the last 12 hours. The next pipeline run shows beside **Run pipeline** on the Home page, and scheduled runs appear on the Activity tab. Use either these schedules or the Windows tasks (`scripts\register-schedule.ps1`, `scripts\register-backup-task.ps1`), not both, or jobs run twice.

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

## Google sign-in setup (optional)

Without this, the web page opens with no login and only on this computer. Turn it on before reaching the
app from another device or the cloud. It uses the Google Cloud project you already have.

1. **Create a web client:** in [Google Cloud](https://console.cloud.google.com), go to Google Auth Platform, then Clients, then Create client. Choose application type **Web application**, and under **Authorized redirect URIs** add `http://localhost:5178/auth/google/callback`. Later, add your cloud address with the same `/auth/google/callback` ending. Only the `openid` and `email` permissions are used, so Google does not need to review anything.
2. **Add to `.env`:**
   ```
   GOOGLE_WEB_CLIENT_ID=...
   GOOGLE_WEB_CLIENT_SECRET=...
   AUTH_ALLOWED_EMAILS=you@gmail.com
   PUBLIC_URL=http://localhost:5178
   ```
3. **Create the secrets:** `npm run auth:setup` creates `SESSION_SECRET` and `USER_KEY_SECRET` (which encrypts the Claude keys other users save) and lists anything still missing. Keep a copy of `USER_KEY_SECRET` in your password manager: without it, saved keys can't be read. `npm run auth:setup -- --rotate` replaces the session secret, which signs everyone out.
4. **Turn it on:** add `AUTH_MODE=google` to `.env` and restart `npm run ui`. Opening the page now sends you to Google. The addresses in `AUTH_ALLOWED_EMAILS` are yours, the owner's. Sessions last 30 days. Remove `AUTH_MODE` to go back to no login.

**Other people** sign in with Google and fill in a short request (their name, a note, and accepting the [terms](TERMS.md) and [privacy policy](PRIVACY.md)). You get an email; approve or reject them on **Admin > Users**, and they get an email back. For each user you choose who pays for their AI: **their own key**, which they add under **Settings** (encrypted, never shown again, not even to you), or **your key**, with a monthly cap you set. You can pause and resume accounts there too.

Each user sets up their own search under **Settings**: the job titles, keywords, and places to look for, and an **About you** text (their resume and notes) that scoring, letters, and meeting prep use, the way your Google Doc does for you. Then they can add jobs, score them, write letters, prepare for meetings, and run their own pipeline from Home, or let it run on the schedule. Their pipeline uses the free job sources; Google results (your paid search), Google Docs, the inbox, and the report email stay yours. Their letters and preps are kept in the app.

**Admin > Users** also shows when each person was last here, their last pipeline run, and how far their setup has got. To pay for someone's AI you type their address to confirm, and they get an email. Users can **Send feedback** from Settings: it is emailed to you (reply to answer them) and listed on Admin > Users, where you mark it done; the Admin tile on Home counts what is waiting.

The scheduled run and the `npm run` commands don't go through the web page, so they are unaffected.

## Encrypted backups (recommended)

A nightly backup encrypts the job database, your search settings, and attached files, and uploads them to a **Job Agent Backups** folder in your Google Drive. It keeps the last 7 nights, then one a week for 3 more weeks, then one more month. The file is encrypted on your computer with a passphrase only you know, so Google cannot read it. Without the passphrase, nobody can restore it, including you.

1. Add a passphrase of at least 16 characters to `.env` as `JOB_BACKUP_PASSPHRASE=...`, and save a copy in your password manager.
2. Check it: `npm run backup -- --check-passphrase`.
3. Back up now: `npm run backup` (it uses the Google sign-in from `npm run google:login`; no new permission is needed).
4. Back up every night at 11 PM: `powershell -ExecutionPolicy Bypass -File scripts\register-backup-task.ps1` (`-At 9:00pm` for another time). Results go to `data\logs\backup.log`.

To write the backup to a folder instead (a USB drive, for example): `npm run backup -- --to E:\JobBackups`.

Once a month (the 1st, 5:00 AM, whenever backups are scheduled) the app also **tests** the newest backup: it decrypts it into a temporary folder, checks the database is sound and has every table, compares row counts with the live data, and deletes the copy. If it fails you get an email. Run it yourself with `npm run backup:test`; turn it off with `SCHEDULE_RESTORE_TEST=off`.

To restore, `npm run backup:restore -- --file latest --out data/restore/job-agent.db` downloads the newest backup and writes **new** files: the database, plus your settings and attachments in `data/restore/restored`. It never touches the live database. The script prints the steps to swap the restored files in.

Your `.env` and Google sign-in files are not backed up, because they hold the passphrase and sign-in tokens. Keep your API keys and passphrase in your password manager.

## Running in the cloud (optional)

On an iPhone, open the app in Safari, tap Share, then **Add to Home Screen**: it opens full screen like an app, with its own icon. **Arrange tiles** on the Home page puts the screens in the order you use them; the order is saved with your data, so every device shows it.

To reach the app from your phone and run the schedule without this computer on, it can run on one small Linux server (a 2 GB AWS Lightsail instance works) in Docker, with Caddy in front for HTTPS. Google sign-in must be on: the server refuses to start without it.

- **The image** (`Dockerfile`) holds code, the built web page, and Chromium. It never holds `.env` or `data/`.
- **The server** keeps everything in `/opt/job-agent`: `compose.yml`, `Caddyfile`, and `deploy.sh` from the `deploy` folder, the `.env` (start from `deploy/cloud.env.example`), and `data/` mounted into the container at `/data`. Make `data/` owned by uid 1000, the container's user.
- **Deploys** (`.github/workflows/deploy.yml`): after CI passes on `main`, GitHub builds the image, publishes it to `ghcr.io/<owner>/job-agent`, and runs `deploy.sh deploy sha-<commit>` over SSH. `deploy.sh` waits for `/healthz` and goes back to the last good image if the new one fails. From the Actions tab, "Run workflow" deploys any earlier tag or rolls back. The deploy step stays off until the repository variable `DEPLOY_ENABLED` is `true`; the workflow lists the four secrets it needs. Make the published package public once (GitHub, Packages, job-agent, Package settings) so the server can pull it, or log the server in to ghcr.io.
- **The schedule** moves to the server's `.env` (`SCHEDULE_PIPELINE`, `SCHEDULE_BACKUP`). Turn the Windows tasks off at the same moment (`register-schedule.ps1 -Remove`); running both creates two diverging job lists.
- **Your data** moves with one copy over SSH: the database (copied with SQLite's backup command so it is consistent), `data/config`, `data/google`, and `.env`. Then add `https://<your address>/auth/google/callback` to the web client's redirect URIs.

## Public demo (optional)

`AUTH_MODE=demo` serves a read-only showcase on made-up data: a fictional candidate, fictional companies, and a sample search with scores, letters, notes, emails, a meeting prep, and pipeline history, dated relative to today. There is no sign-in, every request that would change data is refused, and the server starts without Claude, Gmail, or Drive, so a visitor can never spend money or reach an account.

- **On this computer:** `npm run demo`, then open http://localhost:5180. It rebuilds `demo-data/` each time and never reads `.env`.
- **The sample data** lives in `demo/sample-data.js`; `scripts/demo-seed.js` builds the database and refuses to replace one it did not make.
- **In the cloud:** the `demo` service in `deploy/compose.yml` runs the same image with no secrets, a read-only filesystem, an in-memory database rebuilt on every start, and small memory and CPU limits. Caddy serves it at `DEMO_SITE_ADDRESS` with a `noindex` header. Every request is rate limited per address.

## Privacy

Country data for US-only access: IP to Country Lite by DB-IP (https://db-ip.com), CC BY 4.0.

Everything personal stays on your machine: your settings (`data/config`), Google sign-in (`data/google`), the job database (`data/job-agent.db`), files attached to jobs (`data/attachments`), and API keys (`.env`). The only copy that leaves your machine is the optional encrypted backup to your own Google Drive (and, if you run it in the cloud, the server that then holds these files instead). The `data` folder and `.env` are excluded from Git, and a pre-commit guard (`npm run hooks:install`) blocks commits that contain any of your private terms, API key values, or files from those locations. Prompts in the repo are generic; personal facts belong in your Google Doc.

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
