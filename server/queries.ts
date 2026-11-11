// Database reads and edits behind the API. Rows come back in the shape the UI uses (camelCase).
import { annualize, parseRate, parseHours, findPayInText } from '../tools/rates.ts';
import { checkLocation } from '../tools/location.ts';
import { PROMOTE_AT } from '../agents/discovery/score.ts';
import { findCopies, storedKey, identityKey, liveCopySql } from '../agents/identity.ts';
import { lookups, sqlList } from '../agents/lookups.ts';
import { listAttachments } from './attachments.ts';
import { listPreps } from '../agents/hunt/prep.ts';
import { addNote, listNotes } from '../agents/notes.ts';
import { localDay } from '../tools/dates.ts';
import { describeVersion } from '../agents/prompts.ts';
import { budgetStatus } from '../agents/budget.ts';
import { currentUserId } from '../db/scope.ts';
import { asEngine } from '../db/engine/index.ts';
import { OWNER_ID } from '../db/users.ts';
import type { Database } from '../tools/types.ts';
import type { JobSearchConfig } from '../tools/config.ts';
import type { Rate, RateUnit } from '../tools/rates.ts';
import type { PostingsRow } from '../db/types.ts';

type Lookups = Awaited<ReturnType<typeof lookups>>;
/** The parts of the user's config these reads use. */
type QueryConfig = Partial<Pick<JobSearchConfig, 'fractional' | 'search'>>;
/** A posting row from base(): the job with its latest score and letter, and counts. */
type JobRow = PostingsRow & {
  score: number | null;
  score_source: string | null;
  score_reason: string | null;
  analysis_json: string | null;
  score_model: string | null;
  score_prompt_version: string | null;
  scored_at: string | null;
  awaiting_description: number;
  shares_key: number;
  letter_url: string | null;
  letter_name: string | null;
  letter_flags: string | null;
  letter_id: number | null;
  has_tweaks: number;
  attachment_count: number;
};
/** The Jobs page's filters ('all' or empty means no filter). */
export type PostingFilters = {
  track?: string;
  stage?: string;
  status?: string;
  needsDescription?: string | boolean;
  discoveredAfter?: string;
  q?: string;
  minScore?: number | string | null;
  limit?: number | string;
};
/** An edit from the UI (updatePosting). */
export type PostingPatch = {
  status?: string;
  notes?: string | null;
  appliedOn?: string | null;
  stage?: string;
  track?: string;
  title?: string;
  company?: string;
  location?: string | null;
  description?: string | null;
  rateText?: string | null;
  hoursText?: string | null;
  duplicateOf?: number;
};

/** Status filters that group statuses: 'active' (Needs action) and 'progress' (In progress), by status group. */
const statusFilter = (lk: Lookups, name: string | undefined) => (name === 'active' ? lk.needsAction() : name === 'progress' ? lk.inProgress() : null);

const parse = (s: string | null | undefined) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

// The score a posting is judged by: v2 first, then v1's analysis, then v1's quick score.
const LATEST_SCORE = `(SELECT s.id FROM scores s WHERE s.posting_id = p.id AND s.user_id = p.user_id
  ORDER BY CASE s.source WHEN 'v2' THEN 0 WHEN 'v2-rule' THEN 0 WHEN 'v1-analysis' THEN 1 ELSE 2 END, s.id DESC LIMIT 1)`;
const LATEST_LETTER = `(SELECT a.id FROM artifacts a WHERE a.posting_id = p.id AND a.user_id = p.user_id AND a.kind = 'cover_letter' ORDER BY a.id DESC LIMIT 1)`;

// Jobs worth pasting a description for: no text, still new, found in the last 30 days, and judged
// PROMOTE_AT+ from the title alone (a v1 title score, or a v2 score capped for lack of text, whose
// original is analysis.uncappedScore). They stay in Discovered and the UI highlights them.
export const DESCRIPTION_DAYS = 30;
const NO_TEXT = "TRIM(COALESCE(p.jd_text, '') || COALESCE(p.fetched_text, '')) = ''";
const awaitingDescription = (lk: Lookups) => `(${NO_TEXT} AND p.status IN ${sqlList(lk.ids('status', 'evaluate'))} AND p.stage NOT IN ${sqlList(lk.ids('stage', 'archived'))}
  AND p.discovered_on >= date('now', '-${DESCRIPTION_DAYS} days')
  AND COALESCE(CASE WHEN json_valid(ls.analysis_json) THEN json_extract(ls.analysis_json, '$.uncappedScore') END, ls.score) >= ${PROMOTE_AT})`;

// The row query; db supplies the lists (agents/lookups.ts) the status and stage conditions use. p is the current
// user's postings only (a subquery SQLite flattens, so callers add their own WHERE and indexes still apply).
const base = async (db: Database, lkGiven?: Lookups) => {
  const lk = lkGiven ?? (await lookups(db));
  return `SELECT p.*, ls.score AS score, ls.source AS score_source, ls.reason AS score_reason, ls.analysis_json,
    ls.model AS score_model, ls.prompt_version AS score_prompt_version, ls.created_at AS scored_at,
    ${awaitingDescription(lk)} AS awaiting_description,
    -- flagged only while this job still waits on the user (new) and another live copy exists
    p.status IN ${sqlList(lk.ids('status', 'evaluate'))} AND EXISTS (SELECT 1 FROM postings q WHERE q.user_id = p.user_id AND q.company_title_key = p.company_title_key AND q.id != p.id AND ${await liveCopySql(db)}) AS shares_key,
    ll.doc_url AS letter_url, ll.doc_name AS letter_name, ll.flags_json AS letter_flags, ll.id AS letter_id,
    EXISTS (SELECT 1 FROM artifacts a WHERE a.posting_id = p.id AND a.user_id = p.user_id AND a.kind = 'resume_tweaks') AS has_tweaks,
    (SELECT COUNT(*) FROM attachments f WHERE f.posting_id = p.id AND f.user_id = p.user_id) AS attachment_count
  FROM (SELECT * FROM postings WHERE user_id = @uid) p
  LEFT JOIN scores ls ON ls.id = ${LATEST_SCORE} AND ls.user_id = p.user_id
  LEFT JOIN artifacts ll ON ll.id = ${LATEST_LETTER} AND ll.user_id = p.user_id`;
};

/**
 * The pay to show: the job's own terms (fractional rate, or what the user typed), then the salary the
 * source listed, then the first pay range in the description. from says which.
 */
function payFor(r: JobRow, rate: Rate | null) {
  if (rate) return { ...rate, text: r.rate_text ?? null, from: 'terms' };
  const listed = r.salary ? parseRate(r.salary) : null;
  if (listed?.unit) return { ...listed, text: r.salary, from: 'source' };
  const found = findPayInText(r.jd_text || r.fetched_text);
  return found ? { ...found, from: 'description' } : null;
}

function toRow(r: JobRow, config: QueryConfig) {
  const analysis = parse(r.analysis_json);
  // rate_unit holds one of the units parseRate gives.
  const rate = r.rate_min != null ? { min: r.rate_min, max: r.rate_max ?? r.rate_min, unit: r.rate_unit as RateUnit | null } : null;
  const hours = r.hours_min != null ? { min: r.hours_min, max: r.hours_max ?? r.hours_min } : null;
  const pay = payFor(r, rate);
  return {
    id: r.id,
    title: r.title,
    company: r.company,
    source: r.source,
    url: r.url,
    location: r.location,
    locationCheck: r.location_check,
    track: r.track,
    stage: r.stage,
    status: r.status,
    appliedOn: r.applied_on,
    discoveredOn: r.discovered_on,
    postedOn: r.posted_on,
    score: r.score ?? null,
    scoreSource: r.score_source ?? null,
    fit: analysis?.fit ?? null,
    reason: r.score_reason ?? analysis?.reason ?? null,
    rateText: r.rate_text,
    rate,
    hours,
    pay,
    annualized: annualize(pay, hours, config.fractional?.weeksPerYear ?? 48),
    letter: r.letter_id ? { url: r.letter_url, name: r.letter_name, flags: parse(r.letter_flags) ?? [] } : null,
    hasTweaks: Boolean(r.has_tweaks),
    attachmentCount: r.attachment_count ?? 0,
    needsDescription: !r.jd_text && !r.fetched_text,
    awaitingDescription: Boolean(r.awaiting_description),
    // Placeholder companies ("See posting") share keys without being the same job, so they need a real identity.
    hasCopies: Boolean(r.shares_key) && identityKey(r) !== null,
    fetchStatus: r.fetch_status,
  };
}

/** Filtered list. filters: { track, stage, status, needsDescription, discoveredAfter, q, minScore, limit } ('all' or empty means no filter; status 'active' (Needs action) or 'progress' (In progress) means those status groups). */
export async function listPostings(db: Database, filters: PostingFilters = {}, config: QueryConfig = {}) {
  const lk = await lookups(db);
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (filters.track && filters.track !== 'all') {
    where.push('p.track = @track');
    params.track = filters.track;
  }
  if (filters.stage && filters.stage !== 'all') {
    where.push('p.stage = @stage');
    params.stage = filters.stage;
  }
  if (statusFilter(lk, filters.status)) {
    where.push(`p.status IN ${sqlList(statusFilter(lk, filters.status) as string[])}`);
  } else if (filters.status && filters.status !== 'all') {
    where.push('p.status = @status');
    params.status = filters.status;
  }
  if (String(filters.needsDescription) === 'true') where.push(awaitingDescription(lk));
  if (filters.discoveredAfter) {
    where.push('p.discovered_on >= @discoveredAfter'); // inclusive: jobs found on that day count
    params.discoveredAfter = filters.discoveredAfter;
  }
  if (filters.q) {
    where.push('(p.title LIKE @q OR p.company LIKE @q OR p.location LIKE @q)');
    params.q = `%${filters.q}%`;
  }
  if (filters.minScore != null) {
    where.push('ls.score >= @minScore');
    params.minScore = Number(filters.minScore);
  }
  const limit = Math.min(Number(filters.limit) || 500, 2000);
  const sql = `${await base(db)} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(ls.score, 0) DESC, p.discovered_on DESC, p.id DESC LIMIT ${limit}`;
  return (db.prepare(sql).all(params) as JobRow[]).map((r) => toRow(r, config));
}

/** Full detail for one posting, or null. */
export async function getPosting(db: Database, id: number, config: QueryConfig = {}) {
  const r = db.prepare(`${await base(db)} WHERE p.id = ?`).get(id) as JobRow | undefined;
  if (!r) return null;
  const tweaks = db
    .prepare("SELECT content, model, created_at, resume_id FROM artifacts WHERE posting_id = ? AND user_id = @uid AND kind = 'resume_tweaks' ORDER BY id DESC LIMIT 1")
    .get(id) as { content: string; model: string | null; created_at: string; resume_id: string | null } | undefined;
  const letter = r.letter_id
    ? (db.prepare('SELECT content, doc_url, doc_name, flags_json, created_at, resume_id FROM artifacts WHERE id = ? AND user_id = @uid').get(r.letter_id) as
        | { content: string; doc_url: string | null; doc_name: string | null; flags_json: string | null; created_at: string; resume_id: string | null }
        | undefined)
    : null;
  // Which of the user's resumes a letter or tweaks were written from (null: none, or since deleted).
  const resumeLabel = (rid: string | null) => (rid ? (db.prepare('SELECT label FROM resumes WHERE id = ? AND user_id = @uid').pluck().get(rid) ?? null) : null);
  return {
    ...toRow(r, config),
    copies: await findCopies(db, r),
    attachments: listAttachments(db, r.id),
    meetingPreps: await listPreps(db, r.id),
    noteEntries: await listNotes(db, r.id),
    analysis: parse(r.analysis_json),
    scoreDetails: await scoreDetails(db, r),
    notes: r.notes,
    text: r.jd_text ?? r.fetched_text ?? null,
    textSource: r.jd_text ? 'pasted' : r.fetched_text ? 'fetched' : null,
    extra: parse(r.extra_json),
    tweaks: tweaks ? { content: tweaks.content, model: tweaks.model, createdAt: tweaks.created_at, resume: resumeLabel(tweaks.resume_id) } : null,
    letter: letter ? { url: letter.doc_url, name: letter.doc_name, flags: parse(letter.flags_json) ?? [], content: letter.content, createdAt: letter.created_at, resume: resumeLabel(letter.resume_id) } : null,
    scores: db
      .prepare('SELECT score, source, model, reason, created_at AS createdAt FROM scores WHERE posting_id = ? AND user_id = @uid ORDER BY id DESC')
      .all(id),
    statusHistory: db
      .prepare('SELECT from_status AS fromStatus, to_status AS toStatus, changed_by AS changedBy, changed_at AS changedAt FROM status_history WHERE posting_id = ? AND user_id = @uid ORDER BY id')
      .all(id),
    sightings: db.prepare('SELECT source, url, seen_on AS seenOn FROM posting_sightings WHERE posting_id = ? AND user_id = @uid ORDER BY id').all(id),
  };
}

/**
 * How the current score was made, for the job panel: when, by which model, from the posting text or the title alone
 * (capped), with which prompt (agents/prompts.ts describeVersion), and whether text has arrived since a capped score.
 */
async function scoreDetails(db: Database, r: JobRow) {
  if (r.score == null) return null;
  const analysis = parse(r.analysis_json) ?? {};
  const capped = analysis.uncappedScore != null;
  const hasText = Boolean((r.jd_text || r.fetched_text || '').trim());
  return {
    at: r.scored_at,
    model: r.score_model ?? null,
    source: r.score_source,
    from: r.score_source === 'v1-quick' || capped ? 'title' : String(r.score_source).startsWith('v1') ? 'v1' : r.score_source === 'v2-rule' ? 'rule' : 'text',
    uncappedScore: capped ? analysis.uncappedScore : null,
    textSinceScore: capped && hasText,
    prompt: r.score_source === 'v2' ? await describeVersion(db, (await lookups(db)).scorePrompt(r.track), r.score_prompt_version) : null,
  };
}

/**
 * Applies an edit from the UI. notes adds a new note (agents/notes.ts); notes are edited one by one through their own routes.
 * patch: { status, notes, appliedOn, stage, track, title, company, location,
 * description, rateText, hoursText, duplicateOf }. Status changes are recorded in status_history as the user's.
 * A company or title edit recomputes the duplicate key; duplicateOf marks this copy duplicate and archives it, with a note
 * pointing at the other.
 * Marking a job applied without a date sets today's date. Returns the updated detail, or null if not found.
 */
export async function updatePosting(db: Database, id: number, patch: PostingPatch, config: QueryConfig = {}, now = new Date()) {
  // The read of the job and the writes are one transaction, so two edits at once can not record a stale status.
  return asEngine(db).tx(async () => {
    const lk = await lookups(db);
    const current = db.prepare('SELECT * FROM postings WHERE id = ? AND user_id = @uid').get(id) as PostingsRow | undefined;
    if (!current) return null;
    const set: Partial<PostingsRow> = {};
    const nowIso = now.toISOString();
    // A new choice must be a value in its list that is not archived; a job keeps an archived value it already has.
    for (const list of ['status', 'stage', 'track'] as const) {
      if (patch[list] !== undefined && patch[list] !== current[list] && !lk.selectable(list, patch[list] as string)) {
        throw Object.assign(new Error(`"${patch[list]}" is not an available ${list}. Choose one from the list.`), { statusCode: 400 });
      }
    }
    if (patch.status !== undefined && patch.status !== current.status) {
      set.status = patch.status;
      if (lk.groupOf('status', patch.status) === 'waiting' && !current.applied_on && patch.appliedOn === undefined) set.applied_on = localDay(now);
    }
    if (patch.appliedOn !== undefined) set.applied_on = patch.appliedOn || null;
    const newNotes: Array<{ body: string; source: string }> = [];
    if (patch.notes?.trim()) newNotes.push({ body: patch.notes, source: 'user' });
    if (patch.stage !== undefined) set.stage = patch.stage;
    if (patch.track !== undefined) set.track = patch.track;
    if (patch.title !== undefined && patch.title.trim()) set.title = patch.title.trim();
    if (patch.company !== undefined && patch.company.trim()) set.company = patch.company.trim();
    if (set.title !== undefined || set.company !== undefined) {
      set.company_title_key = storedKey({ company: set.company ?? current.company, title: set.title ?? current.title });
    }
    if (patch.duplicateOf !== undefined) {
      const other = db.prepare('SELECT id, company, title, stage, status FROM postings WHERE id = ? AND user_id = @uid').get(patch.duplicateOf) as
        | Pick<PostingsRow, 'id' | 'company' | 'title' | 'stage' | 'status'>
        | undefined;
      if (!other || other.id === id) throw Object.assign(new Error('The job it duplicates was not found.'), { statusCode: 400 });
      const note = `Duplicate of #${other.id}, ${other.title} at ${other.company} (${other.stage}/${other.status}); archived ${localDay(now)}.`;
      set.stage = lk.role('stage', 'archive') as string; // the stage list always has an archive role
      const duplicate = lk.role('status', 'duplicate') as string; // 023 sets it, and a role is moved, never removed
      if (current.status !== duplicate) set.status = duplicate;
      newNotes.push({ body: note, source: 'agent' });
    }
    if (patch.location !== undefined) set.location = patch.location || null;
    if (patch.description !== undefined) set.jd_text = patch.description?.trim() || null;
    if (patch.rateText !== undefined) {
      const rate = parseRate(patch.rateText);
      Object.assign(set, { rate_text: patch.rateText || null, rate_min: rate?.min ?? null, rate_max: rate?.max ?? null, rate_unit: rate?.unit ?? null });
    }
    if (patch.hoursText !== undefined) {
      const hours = parseHours(patch.hoursText);
      Object.assign(set, { hours_min: hours?.min ?? null, hours_max: hours?.max ?? null });
    }
    if (set.location !== undefined || set.jd_text !== undefined) {
      set.location_check = checkLocation(
        { location: set.location ?? current.location, workplace: current.workplace, text: set.jd_text ?? current.jd_text ?? current.fetched_text },
        config.search?.homeLocations ?? [],
      );
    }
    const keys = Object.keys(set);
    if (keys.length || newNotes.length) {
      await asEngine(db).tx(async () => {
        if (keys.length) db.prepare(`UPDATE postings SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id AND user_id = @uid`).run({ ...set, updated_at: nowIso, id });
        if (set.status) {
          db.prepare("INSERT INTO status_history (user_id, posting_id, from_status, to_status, changed_by, changed_at) VALUES (@uid, ?, ?, ?, 'user', ?)").run(id, current.status, set.status, nowIso);
        }
        for (const n of newNotes) await addNote(db, id, n.body, { source: n.source, now });
      });
    }
    return await getPosting(db, id, config);
  });
}

/** Counts and spend for the header. */
export async function summary(db: Database, config: QueryConfig = {}, now = new Date()) {
  const lk = await lookups(db);
  const uid = currentUserId() ?? OWNER_ID;
  // runs is not a user table (agent-core writes the row first): the user's runs, and for the owner the ones from before runs had a user.
  const mine = '(user_id = @me OR (@me = 1 AND user_id IS NULL))';
  const since = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
  const counts = db.prepare('SELECT track, stage, status, COUNT(*) AS n FROM postings WHERE user_id = @uid GROUP BY track, stage, status').all() as Array<{
    track: string;
    stage: string;
    status: string;
    n: number;
  }>;
  return {
    counts,
    pipeline: counts.filter((c) => lk.groupOf('stage', c.stage) === 'active').reduce((s, c) => s + c.n, 0),
    // The Home page's counts: pipeline jobs that need action (the Jobs page's default view) and ones in progress.
    needsAction: counts.filter((c) => lk.groupOf('stage', c.stage) === 'active' && lk.needsAction().includes(c.status)).reduce((s, c) => s + c.n, 0),
    inProgress: counts.filter((c) => lk.groupOf('stage', c.stage) === 'active' && lk.inProgress().includes(c.status)).reduce((s, c) => s + c.n, 0),
    needsDescription: db.prepare(`SELECT COUNT(*) FROM postings p LEFT JOIN scores ls ON ls.id = ${LATEST_SCORE} AND ls.user_id = p.user_id WHERE p.user_id = @uid AND ${awaitingDescription(lk)}`).pluck().get(),
    fractionalTarget: config.fractional?.targetAnnual ?? null,
    weeksPerYear: config.fractional?.weeksPerYear ?? 48,
    spend30Days: db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE started_at >= @since AND ${mine}`).pluck().get({ since, me: uid }),
    budget: await budgetStatus(db, { now, uid }),
    inboxNeedsReview: db.prepare("SELECT COUNT(*) FROM emails WHERE user_id = @uid AND review_status = 'needs_review'").pluck().get(),
    lastRun: db.prepare(`SELECT name, status, started_at AS startedAt FROM runs WHERE name IN ('pipeline', 'discover') AND ${mine} ORDER BY id DESC LIMIT 1`).get({ me: uid }) ?? null,
  };
}
