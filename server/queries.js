// Database reads and edits behind the API. Rows come back in the shape the UI uses (camelCase).
import { annualize, parseRate, parseHours, findPayInText } from '../tools/rates.js';
import { checkLocation } from '../tools/location.js';
import { PROMOTE_AT } from '../agents/discovery/score.js';
import { findCopies, storedKey, identityKey, LIVE_COPY } from '../agents/identity.js';

export const STATUSES = ['new', 'applied', 'interviewing', 'offer', 'passed', 'closed', 'rejected', 'duplicate'];
/** Status filters that group statuses: 'active' is what waits on the user to evaluate or decide; 'progress' is under way. */
export const STATUS_GROUPS = { active: ['new', 'offer'], progress: ['applied', 'interviewing', 'offer'] };
export const STAGES = ['discovered', 'pipeline', 'archived'];
export const TRACKS = ['fulltime', 'fractional'];

const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

// The score a posting is judged by: v2 first, then v1's analysis, then v1's quick score.
const LATEST_SCORE = `(SELECT s.id FROM scores s WHERE s.posting_id = p.id
  ORDER BY CASE s.source WHEN 'v2' THEN 0 WHEN 'v2-rule' THEN 0 WHEN 'v1-analysis' THEN 1 ELSE 2 END, s.id DESC LIMIT 1)`;
const LATEST_LETTER = `(SELECT a.id FROM artifacts a WHERE a.posting_id = p.id AND a.kind = 'cover_letter' ORDER BY a.id DESC LIMIT 1)`;

// Jobs worth pasting a description for: no text, still new, found in the last 30 days, and judged
// PROMOTE_AT+ from the title alone (a v1 title score, or a v2 score capped for lack of text, whose
// original is analysis.uncappedScore). They stay in Discovered and the UI highlights them.
export const DESCRIPTION_DAYS = 30;
const NO_TEXT = "TRIM(COALESCE(p.jd_text, '') || COALESCE(p.fetched_text, '')) = ''";
const AWAITING_DESCRIPTION = `(${NO_TEXT} AND p.status = 'new' AND p.stage != 'archived'
  AND p.discovered_on >= date('now', '-${DESCRIPTION_DAYS} days')
  AND COALESCE(CASE WHEN json_valid(ls.analysis_json) THEN json_extract(ls.analysis_json, '$.uncappedScore') END, ls.score) >= ${PROMOTE_AT})`;

const BASE = `SELECT p.*, ls.score AS score, ls.source AS score_source, ls.reason AS score_reason, ls.analysis_json,
    ${AWAITING_DESCRIPTION} AS awaiting_description,
    -- flagged only while this job still waits on the user (new) and another live copy exists
    p.status = 'new' AND EXISTS (SELECT 1 FROM postings q WHERE q.company_title_key = p.company_title_key AND q.id != p.id AND ${LIVE_COPY}) AS shares_key,
    ll.doc_url AS letter_url, ll.doc_name AS letter_name, ll.flags_json AS letter_flags, ll.id AS letter_id,
    EXISTS (SELECT 1 FROM artifacts a WHERE a.posting_id = p.id AND a.kind = 'resume_tweaks') AS has_tweaks
  FROM postings p
  LEFT JOIN scores ls ON ls.id = ${LATEST_SCORE}
  LEFT JOIN artifacts ll ON ll.id = ${LATEST_LETTER}`;

/**
 * The pay to show: the job's own terms (fractional rate, or what the user typed), then the salary the
 * source listed, then the first pay range in the description. from says which.
 */
function payFor(r, rate) {
  if (rate) return { ...rate, text: r.rate_text ?? null, from: 'terms' };
  const listed = r.salary ? parseRate(r.salary) : null;
  if (listed?.unit) return { ...listed, text: r.salary, from: 'source' };
  const found = findPayInText(r.jd_text || r.fetched_text);
  return found ? { ...found, from: 'description' } : null;
}

function toRow(r, config) {
  const analysis = parse(r.analysis_json);
  const rate = r.rate_min != null ? { min: r.rate_min, max: r.rate_max ?? r.rate_min, unit: r.rate_unit } : null;
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
    needsDescription: !r.jd_text && !r.fetched_text,
    awaitingDescription: Boolean(r.awaiting_description),
    // Placeholder companies ("See posting") share keys without being the same job, so they need a real identity.
    hasCopies: Boolean(r.shares_key) && identityKey(r) !== null,
    fetchStatus: r.fetch_status,
  };
}

/** Filtered list. filters: { track, stage, status, needsDescription, discoveredAfter, q, minScore, limit } ('all' or empty means no filter; status 'active' or 'progress' means a STATUS_GROUPS group). */
export function listPostings(db, filters = {}, config = {}) {
  const where = [];
  const params = {};
  if (filters.track && filters.track !== 'all') {
    where.push('p.track = @track');
    params.track = filters.track;
  }
  if (filters.stage && filters.stage !== 'all') {
    where.push('p.stage = @stage');
    params.stage = filters.stage;
  }
  if (STATUS_GROUPS[filters.status]) {
    where.push(`p.status IN (${STATUS_GROUPS[filters.status].map((s) => `'${s}'`).join(', ')})`);
  } else if (filters.status && filters.status !== 'all') {
    where.push('p.status = @status');
    params.status = filters.status;
  }
  if (String(filters.needsDescription) === 'true') where.push(AWAITING_DESCRIPTION);
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
  const sql = `${BASE} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(ls.score, 0) DESC, p.discovered_on DESC, p.id DESC LIMIT ${limit}`;
  return db.prepare(sql).all(params).map((r) => toRow(r, config));
}

/** Full detail for one posting, or null. */
export function getPosting(db, id, config = {}) {
  const r = db.prepare(`${BASE} WHERE p.id = ?`).get(id);
  if (!r) return null;
  const tweaks = db
    .prepare("SELECT content, model, created_at FROM artifacts WHERE posting_id = ? AND kind = 'resume_tweaks' ORDER BY id DESC LIMIT 1")
    .get(id);
  const letter = r.letter_id ? db.prepare('SELECT content, doc_url, doc_name, flags_json, created_at FROM artifacts WHERE id = ?').get(r.letter_id) : null;
  return {
    ...toRow(r, config),
    copies: findCopies(db, r),
    analysis: parse(r.analysis_json),
    notes: r.notes,
    text: r.jd_text ?? r.fetched_text ?? null,
    textSource: r.jd_text ? 'pasted' : r.fetched_text ? 'fetched' : null,
    extra: parse(r.extra_json),
    tweaks: tweaks ? { content: tweaks.content, model: tweaks.model, createdAt: tweaks.created_at } : null,
    letter: letter ? { url: letter.doc_url, name: letter.doc_name, flags: parse(letter.flags_json) ?? [], content: letter.content, createdAt: letter.created_at } : null,
    scores: db
      .prepare('SELECT score, source, model, reason, created_at AS createdAt FROM scores WHERE posting_id = ? ORDER BY id DESC')
      .all(id),
    statusHistory: db
      .prepare('SELECT from_status AS fromStatus, to_status AS toStatus, changed_by AS changedBy, changed_at AS changedAt FROM status_history WHERE posting_id = ? ORDER BY id')
      .all(id),
    sightings: db.prepare('SELECT source, url, seen_on AS seenOn FROM posting_sightings WHERE posting_id = ? ORDER BY id').all(id),
  };
}

/**
 * Applies an edit from the UI. patch: { status, notes, appliedOn, stage, track, title, company, location,
 * description, rateText, hoursText, duplicateOf }. Status changes are recorded in status_history as the user's.
 * A company or title edit recomputes the duplicate key; duplicateOf marks this copy duplicate and archives it, with a note
 * pointing at the other.
 * Marking a job applied without a date sets today's date. Returns the updated detail, or null if not found.
 */
export function updatePosting(db, id, patch, config = {}, now = new Date()) {
  const current = db.prepare('SELECT * FROM postings WHERE id = ?').get(id);
  if (!current) return null;
  const set = {};
  const nowIso = now.toISOString();
  if (patch.status !== undefined && patch.status !== current.status) {
    set.status = patch.status;
    if (patch.status === 'applied' && !current.applied_on && patch.appliedOn === undefined) set.applied_on = nowIso.slice(0, 10);
  }
  if (patch.appliedOn !== undefined) set.applied_on = patch.appliedOn || null;
  if (patch.notes !== undefined) set.notes = patch.notes || null;
  if (patch.stage !== undefined) set.stage = patch.stage;
  if (patch.track !== undefined) set.track = patch.track;
  if (patch.title !== undefined && patch.title.trim()) set.title = patch.title.trim();
  if (patch.company !== undefined && patch.company.trim()) set.company = patch.company.trim();
  if (set.title !== undefined || set.company !== undefined) {
    set.company_title_key = storedKey({ company: set.company ?? current.company, title: set.title ?? current.title });
  }
  if (patch.duplicateOf !== undefined) {
    const other = db.prepare('SELECT id, company, title, stage, status FROM postings WHERE id = ?').get(patch.duplicateOf);
    if (!other || other.id === id) throw Object.assign(new Error('The job it duplicates was not found.'), { statusCode: 400 });
    const note = `Duplicate of #${other.id}, ${other.title} at ${other.company} (${other.stage}/${other.status}); archived ${nowIso.slice(0, 10)}.`;
    set.stage = 'archived';
    if (current.status !== 'duplicate') set.status = 'duplicate';
    set.notes = [set.notes ?? current.notes, note].filter(Boolean).join('\n');
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
  if (keys.length) {
    db.transaction(() => {
      db.prepare(`UPDATE postings SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`).run({ ...set, updated_at: nowIso, id });
      if (set.status) {
        db.prepare("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, ?, ?, 'user', ?)").run(id, current.status, set.status, nowIso);
      }
    })();
  }
  return getPosting(db, id, config);
}

/** Counts and spend for the header. */
export function summary(db, config = {}, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
  const counts = db.prepare('SELECT track, stage, status, COUNT(*) AS n FROM postings GROUP BY track, stage, status').all();
  return {
    counts,
    pipeline: counts.filter((c) => c.stage === 'pipeline').reduce((s, c) => s + c.n, 0),
    needsDescription: db.prepare(`SELECT COUNT(*) FROM postings p LEFT JOIN scores ls ON ls.id = ${LATEST_SCORE} WHERE ${AWAITING_DESCRIPTION}`).pluck().get(),
    fractionalTarget: config.fractional?.targetAnnual ?? null,
    weeksPerYear: config.fractional?.weeksPerYear ?? 48,
    spend30Days: db.prepare('SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE started_at >= ?').pluck().get(since),
    inboxNeedsReview: db.prepare("SELECT COUNT(*) FROM emails WHERE review_status = 'needs_review'").pluck().get(),
    lastRun: db.prepare("SELECT name, status, started_at AS startedAt FROM runs WHERE name IN ('pipeline', 'discover') ORDER BY id DESC LIMIT 1").get() ?? null,
  };
}
