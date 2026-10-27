// Builds the public demo's database from demo/sample-data.js: a fictional candidate's job search with scores,
// analyses, letters, notes, emails, a meeting prep, and pipeline history, dated relative to today.
//
//   DATA_DIR=demo-data node scripts/demo-seed.js           build demo-data/job-agent.db and its config
//   DATA_DIR=demo-data node scripts/demo-seed.js --force   replace an existing demo database
//
// It refuses to run without DATA_DIR, and refuses to touch a database it did not make, so it can never overwrite
// a real job search. The demo container runs it on every start, so the demo resets to fresh sample data.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataPath, DATA_DIR } from '../tools/paths.js';
import { openJobStore } from '../db/index.js';
import { localDay } from '../tools/dates.js';
import Database from 'better-sqlite3';
import { setSetting } from '../db/settings.js';
import { addNote } from '../agents/notes.js';
import { companyTitleKey } from '../tools/urls.js';
import { DEFAULT_SCORE_MODEL } from '../agents/discovery/score.js';
import { CANDIDATE, DEMO_CONFIG, JOBS, PROMPT_EDITS, REVIEW_EMAIL, STRENGTHS, WATCH_OUTS, companyBlurb } from '../demo/sample-data.js';
import { defaultPrompt, validateTemplate, versionOf } from '../agents/prompts.js';

const MARKER = 'demo_database';
const LETTER_MODEL = 'claude-sonnet-5-5';

/** Builds the demo database at dbPath (and its config beside it). Returns counts. now is injectable for tests. */
export function seedDemo({ dbPath = dataPath('job-agent.db'), configPath = dataPath('config', 'job-search.json'), now = new Date(), prompts = samplePrompts() } = {}) {
  const at = (days, hour = 9, minute = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() - days);
    d.setHours(hour, minute, 0, 0);
    return d;
  };
  const iso = (days, hour, minute) => at(days, hour, minute).toISOString();
  const day = (days) => localDay(at(days));

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(DEMO_CONFIG, null, 2)}\n`);

  const store = openJobStore(dbPath);
  const { db } = store;
  setSetting(db, MARKER, 'true');

  const insertPosting = db.prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, source, location, salary, posted_on,
      discovered_on, stage, status, applied_on, fetched_text, fetched_at, fetch_status, fetch_method, workplace, location_check, track,
      rate_text, rate_min, rate_max, rate_unit, hours_min, hours_max, created_at, updated_at)
    VALUES (@uid, @url, @url, @company, @title, @key, @source, @location, @salary, @postedOn, @discoveredOn, @stage, @status, @appliedOn,
      @text, @fetchedAt, @fetchStatus, @fetchMethod, @workplace, @locationCheck, @track, @rateText, @rateMin, @rateMax, @rateUnit,
      @hoursMin, @hoursMax, @createdAt, @updatedAt)`);
  const insertScore = db.prepare(`INSERT INTO scores (user_id, posting_id, score, reason, analysis_json, source, model, prompt_version, run_id, created_at)
    VALUES (@uid, ?, ?, ?, ?, 'v2', ?, ?, ?, ?)`);
  // Each sample score records the version of the scoring prompt in effect (the sample edit where there is one), as a
  // real score does, so the job panel's score details show it.
  const scoreVersion = (job) => {
    const name = job.track === 'fractional' ? 'score-fractional' : 'score';
    return versionOf(name, prompts.find((p) => p.name === name)?.template ?? defaultPrompt(name).template);
  };
  const insertArtifact = db.prepare(`INSERT INTO artifacts (user_id, posting_id, kind, content, doc_name, flags_json, source, model, prompt_version, run_id, created_at)
    VALUES (@uid, ?, ?, ?, ?, ?, 'v2', ?, 'default', ?, ?)`);
  const insertHistory = db.prepare('INSERT INTO status_history (user_id, posting_id, from_status, to_status, changed_by, changed_at) VALUES (@uid, ?, ?, ?, ?, ?)');
  const insertSighting = db.prepare('INSERT INTO posting_sightings (user_id, posting_id, source, url, seen_on) VALUES (@uid, ?, ?, ?, ?)');
  const insertEmail = db.prepare(`INSERT INTO emails (user_id, id, gmail_message_id, thread_id, sender, sender_domain, sent_at, subject, type, posting_id,
      match_rule, confidence, review_status, review_reason, summary, prompt_version, model, created_at, updated_at)
    VALUES (@uid, @id, @gmailId, @threadId, @sender, @domain, @sentAt, @subject, @type, @postingId, @rule, @confidence, @review, @reason,
      @summary, 'default', 'claude-haiku-4-5', @sentAt, @sentAt)`);
  const insertReminder = db.prepare('INSERT INTO reminders (user_id, id, posting_id, email_id, kind, due_at, note, status, created_at) VALUES (@uid, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertRun = db.prepare(`INSERT INTO runs (name, meta, status, started_at, finished_at, duration_ms, calls, input_tokens, output_tokens,
      cache_read_tokens, cost_usd, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertCall = db.prepare(`INSERT INTO run_calls (run_id, label, model, stop_reason, input_tokens, output_tokens, cache_read_tokens, cost_usd,
      duration_ms, created_at) VALUES (?, ?, ?, 'end_turn', ?, ?, ?, ?, ?, ?)`);

  // Pipeline history: Monday and Thursday mornings over the last nine weeks, plus the inbox checks after each.
  const runIds = [];
  for (let days = 63; days >= 0; days -= 1) {
    const d = at(days, 6, 0);
    if (![1, 4].includes(d.getDay())) continue;
    const scored = 18 + ((days * 7) % 23);
    const letters = 1 + (days % 3);
    const cost = Number((scored * 0.021 + letters * 0.09).toFixed(4));
    const started = d.toISOString();
    const finished = new Date(d.getTime() + (9 + (days % 5)) * 60000).toISOString();
    const summary = { discovered: scored + 11, scored, promoted: 1 + (days % 4), letters, archived: 3 + (days % 6) };
    const id = Number(insertRun.run('pipeline', null, 'ok', started, finished, 9 * 60000, scored + letters * 2, scored * 5200, scored * 380, scored * 4100, cost, JSON.stringify(summary)).lastInsertRowid);
    for (let i = 0; i < Math.min(scored, 6); i += 1) {
      insertCall.run(id, i % 4 === 3 ? 'score-fractional' : 'score', DEFAULT_SCORE_MODEL, 5200, 380, 4100, Number((cost * 0.12).toFixed(4)), 4200, started);
    }
    for (let i = 0; i < letters; i += 1) {
      insertCall.run(id, 'cover-letter', LETTER_MODEL, 7800, 900, 4100, 0.06, 18000, started);
      insertCall.run(id, 'resume-tweaks', LETTER_MODEL, 7600, 600, 4100, 0.03, 12000, started);
    }
    const inbox = insertRun.run('inbox', null, 'ok', finished, finished, 40000, 3, 2400, 150, 0, 0.004, JSON.stringify({ fetched: 9, linked: 2, needsReview: 0 })).lastInsertRowid;
    insertCall.run(Number(inbox), 'inbox-classify', 'claude-haiku-4-5', 2400, 150, 0, 0.004, 1500, finished);
    runIds.push({ id, days });
  }
  const runFor = (days) => (runIds.find((r) => r.days <= days + 3 && r.days >= days) ?? runIds.at(-1)).id;

  let postings = 0;
  let emails = 0;
  for (const [i, job] of JOBS.entries()) {
    const track = job.track ?? 'fulltime';
    const url = `https://jobs.example.com/${slug(job.company)}/${slug(job.title)}`;
    const text = job.noText ? null : description(job);
    const discoveredAt = iso(job.days, 6, 5 + (i % 40));
    const id = Number(
      insertPosting.run({
        url,
        company: job.company,
        title: job.title,
        key: companyTitleKey(job.company, job.title),
        source: job.source,
        location: job.location,
        salary: job.salary ?? null,
        postedOn: day(job.days + 1),
        discoveredOn: day(job.days),
        stage: job.stage,
        status: job.status,
        appliedOn: job.applied != null ? day(job.applied) : null,
        text,
        fetchedAt: text ? discoveredAt : null,
        fetchStatus: text ? 'ok' : 'needs_text',
        fetchMethod: text ? 'source' : null,
        workplace: job.workplace,
        locationCheck: job.workplace === 'remote' ? 'remote' : 'home',
        track,
        rateText: job.rate?.[0] ?? null,
        rateMin: job.rate?.[1] ?? null,
        rateMax: job.rate?.[2] ?? null,
        rateUnit: job.rate?.[3] ?? null,
        hoursMin: job.hours?.[0] ?? null,
        hoursMax: job.hours?.[1] ?? null,
        createdAt: discoveredAt,
        updatedAt: discoveredAt,
      }).lastInsertRowid,
    );
    postings += 1;
    insertSighting.run(id, job.source, url, day(job.days));

    const run = runFor(job.days);
    const analysis = analysisFor(job, i, text);
    insertScore.run(id, analysis.score, analysis.reason, JSON.stringify(analysis), DEFAULT_SCORE_MODEL, scoreVersion(job), run, discoveredAt);

    if (job.letter) {
      const flags = i % 5 === 2 ? ['over the word limit'] : [];
      insertArtifact.run(id, 'cover_letter', letter(job), `Cover letter: ${job.company}, ${job.title}`, JSON.stringify(flags), LETTER_MODEL, run, discoveredAt);
    }
    if (job.tweaks) insertArtifact.run(id, 'resume_tweaks', tweaks(job, i), null, null, LETTER_MODEL, run, discoveredAt);

    // Status history: promotion by the agent, then the candidate's own moves.
    insertHistory.run(id, null, 'new', 'agent', discoveredAt);
    let status = 'new';
    if (job.applied != null) {
      insertHistory.run(id, status, 'applied', 'user', iso(job.applied, 10, 15));
      status = 'applied';
    }
    for (const [to, days] of job.history ?? []) {
      insertHistory.run(id, status, to, ['passed', 'closed'].includes(to) ? 'user' : 'agent', iso(days, 14, 30));
      status = to;
    }

    for (const [daysAgo, body] of job.notes ?? []) addNote(db, id, body, { source: 'user', now: at(daysAgo, 17, 10) });
    if (job.closeNote) addNote(db, id, job.closeNote, { source: 'user', now: at((job.history?.at(-1)?.[1] ?? job.days) - 0, 18, 0) });

    const threadId = `demo-thread-${id}`;
    for (const [type, days, subject, summary] of job.emails ?? []) {
      const emailId = randomUUID();
      insertEmail.run({
        id: emailId,
        gmailId: `demo-${randomUUID()}`,
        threadId,
        sender: `talent@${slug(job.company)}.example.com`,
        domain: `${slug(job.company)}.example.com`,
        sentAt: iso(days, 11, 20),
        subject,
        type,
        postingId: id,
        rule: type === 'confirmation' ? 'ats_subject' : 'domain',
        confidence: 1,
        review: 'auto',
        reason: null,
        summary,
      });
      emails += 1;
    }
    // An open reminder (an interview or a take home exercise coming up), tied to the job's latest email.
    if (job.reminder) {
      const [kind, dueIn, note] = job.reminder;
      const lastEmail = db.prepare('SELECT id FROM emails WHERE posting_id = ? AND user_id = @uid ORDER BY sent_at DESC LIMIT 1').pluck().get(id) ?? null;
      insertReminder.run(randomUUID(), id, lastEmail, kind, at(dueIn, 13, 0).toISOString(), note, 'open', iso(1, 9, 0));
    }
    if (job.prep) insertPrep(db, id, job, at(2, 19, 0).toISOString(), run);
  }

  // One email the inbox could not place, so the review queue has something to show.
  insertEmail.run({
    id: randomUUID(),
    gmailId: `demo-${randomUUID()}`,
    threadId: 'demo-thread-review',
    sender: REVIEW_EMAIL.sender,
    domain: REVIEW_EMAIL.sender.split('@')[1],
    sentAt: iso(REVIEW_EMAIL.days, 15, 40),
    subject: REVIEW_EMAIL.subject,
    type: REVIEW_EMAIL.type,
    postingId: null,
    rule: 'model',
    confidence: 0.42,
    review: 'needs_review',
    reason: REVIEW_EMAIL.reason,
    summary: REVIEW_EMAIL.summary,
  });
  emails += 1;

  // Prompt edits shown on the Admin screen, each a saved version on top of the repo default.
  const savePrompt = db.prepare('INSERT INTO prompt_versions (user_id, name, template, note, active, created_at) VALUES (@uid, ?, ?, ?, 1, ?)');
  for (const [i, p] of prompts.entries()) savePrompt.run(p.name, p.template, p.note ?? 'Tuned for this search', iso(20 - i, 16, 0));

  store.close();
  return { postings, emails, runs: runIds.length, prompts: prompts.length };
}

/** True when the database at path was made by this script (or does not exist yet). Opens it read-only. */
export function isDemoDatabase(path) {
  if (!existsSync(path)) return true;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const hasSettings = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get();
    return Boolean(hasSettings && db.prepare('SELECT value FROM app_settings WHERE key = ?').pluck().get(MARKER) === 'true');
  } finally {
    db.close();
  }
}

/** The sample prompt edits: each repo default with its tuning line added. Throws if a default changed so much that an edit no longer validates. */
export function samplePrompts() {
  return PROMPT_EDITS.map(({ name, note, append }) => {
    const template = defaultPrompt(name).template.trimEnd() + append;
    const problems = validateTemplate(name, template);
    if (problems.length) throw new Error(`demo-seed: the sample edit to ${name} no longer validates: ${problems.join(' ')}`);
    return { name, template, note };
  });
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function description(job) {
  const what = companyBlurb(job.company);
  const lead = job.track === 'fractional' ? `${job.company} is looking for a part time engineering leader` : `${job.company} is hiring a ${job.title}`;
  const pay = job.salary ? `\n\nCompensation: ${job.salary} base, plus bonus and equity.` : job.rate ? `\n\nRate: ${job.rate[0]}, about ${job.hours[0]} to ${job.hours[1]} hours a week.` : '';
  return `${lead}. We are ${what}.

About the role
You will lead an engineering organization of 15 to 40 people across product engineering, platform, data, and quality. You report to the CEO and partner closely with product, operations, and compliance. The first year is about stabilizing the core platform, raising release quality, and building a team that can double without slowing down.

What you will do
- Own the technical strategy and the roadmap for the core platform
- Hire, coach, and grow engineering managers and senior engineers
- Lead the move from a monolith to well defined services where it pays off
- Keep the platform secure and compliant (HIPAA, SOC 2) as the company grows
- Bring data and AI into the product and into how the team works

What you bring
- 10+ years in software, including 5+ leading engineering teams
- A record of scaling a platform and a team through a period of fast growth
- Experience in a regulated industry, ideally healthcare
- Comfort with distributed teams across time zones
- Clear writing and steady judgment with executives and boards

Location: ${job.location}.${pay}`;
}

function analysisFor(job, i, text) {
  const pick = (list, n) => Array.from({ length: n }, (_, k) => list[(i + k * 3) % list.length]);
  const strengths = pick(STRENGTHS, 3);
  // A location watch-out only where the job's own location says so, so no sample contradicts its posting.
  const place = { hybrid: 'Hybrid schedule two days a week in the office', onsite: 'Onsite every day' }[job.workplace];
  const watchOuts = [...(place ? [place] : []), ...pick(WATCH_OUTS, job.score >= 8 ? 1 : 2)].slice(0, 2);
  const capped = !text && job.score > 5;
  const score = capped ? 5 : job.score;
  const reason =
    job.score >= 8
      ? `Strong match: ${companyBlurb(job.company)} needs exactly the scaling and regulated platform work ${CANDIDATE.name.split(' ')[0]} has done.`
      : job.score >= 7
        ? 'Good fit on scope and industry, with one or two gaps to address in the letter.'
        : job.score >= 5
          ? 'Relevant leadership role, but the industry or level is a weaker match.'
          : 'Different focus or onsite requirement; not worth pursuing.';
  const base = {
    score,
    reason: capped ? `${reason} Capped at 5 until there is a description to read.` : reason,
    roleType: job.roleType ?? (job.track === 'fractional' ? 'Fractional' : 'Full time'),
    locationConcern: job.workplace === 'onsite' ? 'conflict' : 'none',
    strengths,
    watchOuts,
    topTalkingPoint: strengths[0],
    suggestedStatus: job.score >= 7 ? 'worth_pursuing' : 'pass',
    ...(capped ? { uncappedScore: job.score } : {}),
  };
  if (job.track !== 'fractional') return base;
  return {
    ...base,
    fit: job.fit ?? 'Medium',
    whyItFits: `Part time leadership for ${companyBlurb(job.company)}, a close match to past platform work.`,
    caveats: 'Hours could grow past the stated range during a launch.',
    rate: { min: job.rate[1], max: job.rate[2], unit: job.rate[3] },
    hoursPerWeek: { min: job.hours[0], max: job.hours[1] },
  };
}

function letter(job) {
  return `When I read that ${job.company} is ${companyBlurb(job.company)}, I recognized the stage you are in: the product works, customers depend on it, and the platform and team now have to grow faster than they were built to.

That is the work I have done for the last decade. I grew a care coordination platform team from 6 engineers to 45 while keeping releases weekly, rebuilt a claims rules engine that cut processing time by 60 percent, and led the technology side of an accreditation that closed with no findings. I have run teams across the United States, Poland, and Colombia, and I am at my best translating an executive team's goals into milestones engineers can deliver.

For the ${job.title} role, I would start by listening: to customers, to the team, and to the numbers. In the first 90 days I would map the platform's real constraints, set a release and quality baseline, and agree with you on the two or three bets that matter most for the year.

I would welcome a conversation about where ${job.company} is headed and how I can help it get there.`;
}

function tweaks(job, i) {
  return `Summary: lead with regulated platform scaling and team growth; name ${job.company.split(' ')[0]}'s market in the first line.

1. Move "${STRENGTHS[(i + 3) % STRENGTHS.length]}" into the top three bullets.
2. Add the team size and budget to the most recent role (45 engineers, $9M budget).
3. Rename "Platform modernization" to "Monolith to services migration" to match the posting's language.
4. Cut the 2012 to 2014 role to one line to make room.`;
}

// A case discussion (Arbor's 90 day plan): the CEO, with what the plan should cover and what is still unknown.
function insertCasePrep(db, postingId, job, createdAt, runId) {
  const attendees = [{ name: 'Avery Brooks', role: 'CEO', firm: job.company, link: null, notes: 'Ran the first conversation; former site operations lead' }];
  const content = `# Meeting prep: ${job.company}, ${job.title}

## The meeting
A 60 minute video session with Avery Brooks (CEO) to walk through your 90 day plan for the site platform. It is the take home case from the second round, so expect follow-up questions on each phase.

## What they care about
- ${companyBlurb(job.company)[0].toUpperCase()}${companyBlurb(job.company).slice(1)}; enrollment is growing faster than the platform.
- Sites report slow onboarding and duplicate data entry between trial systems.
- Every change has to keep the audit trail regulators expect.

## A shape for the plan
1. **Days 1 to 30, listen:** meet the site leads and the engineering managers, map the trial systems and where data is typed twice, and set a release and incident baseline.
2. **Days 31 to 60, choose:** agree on two bets with the CEO, most likely site onboarding and one shared patient record, with the cost of each.
3. **Days 61 to 90, deliver:** ship the first onboarding improvement to two pilot sites and report the before and after numbers.

## Stories to tell
1. **Accreditation:** the technology side of an inspection with no findings, as proof you can change systems without losing the audit trail.
2. **Team growth:** 6 to 45 engineers with weekly releases, for how you would grow this team.

## Questions to ask
- Which sites would volunteer for a pilot?
- What has the board been promised for the next two quarters?

## Not known yet
- The size of the current engineering team and its split between product and site support; ask before committing to dates.
- Whether the plan should assume the current vendor contracts stay in place.`;
  db.prepare(`INSERT INTO meeting_preps (user_id, id, posting_id, attendees_json, meeting_at, meeting_kind, meeting_format, context, research, content,
      doc_name, model, prompt_version, cost_usd, web_searches, run_id, created_at)
    VALUES (@uid, ?, ?, ?, ?, 'Executive, owner, or investor', 'video', ?, 1, ?, ?, 'claude-opus-5-5', 'default', 1.18, 7, ?, ?)`).run(
    randomUUID(), postingId, JSON.stringify(attendees), null, 'Walk through the take home case: a 90 day plan for the site platform.', content,
    `Meeting prep: ${job.company}`, runId, createdAt,
  );
}

function insertPrep(db, postingId, job, createdAt, runId) {
  if (job.prep === 'case') return insertCasePrep(db, postingId, job, createdAt, runId);
  const attendees = [
    { name: 'Morgan Lee', role: 'CTO', firm: job.company, link: null, notes: 'Hiring manager; ex consulting' },
    { name: 'Riley Chen', role: 'VP Product', firm: job.company, link: null, notes: '' },
  ];
  const content = `# Meeting prep: ${job.company}, ${job.title}

## The meeting
A 45 minute video interview with Morgan Lee (CTO) and Riley Chen (VP Product). Expect questions on scaling the team and on how you would run the first 90 days.

## What they care about
- ${companyBlurb(job.company)[0].toUpperCase()}${companyBlurb(job.company).slice(1)}; growth has outpaced the platform.
- Release quality and on call load are the visible pain.
- Product wants faster experiments without breaking compliance.

## Stories to tell
1. **Team growth:** 6 to 45 engineers in three years, releases stayed weekly.
2. **Rules engine rebuild:** claims processing time down 60 percent; how you phased it to avoid a big bang cutover.
3. **Accreditation:** the technology side of an inspection with no findings.

## Questions to ask
- What would make this hire a clear success twelve months from now?
- Where does the platform hurt most today: reliability, speed, or cost?
- How do product and engineering decide what not to build?

## Watch outs
- They may probe depth in their exact market; connect it to the regulated platform work you have done.
- Ask early about the reporting line and the team's current managers.`;
  db.prepare(`INSERT INTO meeting_preps (user_id, id, posting_id, attendees_json, meeting_at, meeting_kind, meeting_format, context, research, content,
      doc_name, model, prompt_version, cost_usd, web_searches, run_id, created_at)
    VALUES (@uid, ?, ?, ?, ?, 'interview', 'video', ?, 1, ?, ?, 'claude-opus-5-5', 'default', 1.42, 9, ?, ?)`).run(
    randomUUID(), postingId, JSON.stringify(attendees), null, 'Second round; they asked for a 90 day plan conversation.', content,
    `Meeting prep: ${job.company}`, runId, createdAt,
  );
}

// Command line: build (or with --force, rebuild) the demo database in DATA_DIR. Returns the exit code.
export function main(args = process.argv.slice(2)) {
  if (!process.env.DATA_DIR) {
    console.error('demo-seed: set DATA_DIR to the demo data folder (for example DATA_DIR=demo-data) so the real data folder is never touched.');
    return 1;
  }
  const dbPath = dataPath('job-agent.db');
  if (existsSync(dbPath)) {
    if (!isDemoDatabase(dbPath)) {
      console.error(`demo-seed: ${dbPath} is not a demo database; refusing to replace it.`);
      return 1;
    }
    if (!args.includes('--force')) {
      console.error(`demo-seed: ${dbPath} already exists; pass --force to rebuild it.`);
      return 1;
    }
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  }
  const counts = seedDemo({ dbPath });
  console.log(`Demo data in ${DATA_DIR}: ${counts.postings} jobs, ${counts.emails} emails, ${counts.runs} pipeline runs, ${counts.prompts} prompt edits.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
