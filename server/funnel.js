// The application funnel: Applied -> Responded -> Interview -> Offer, with rates, timing, results by source,
// applications per week, and the applications waiting for a reply. Built from status groups
// (agents/lookups.js), status history, and linked emails, so statuses added later count automatically.
// Timing uses only dated events (your changes, the agent's, and emails); v1-imported history has the import
// date, not the real one, so it counts a milestone but not its timing.
import { lookups } from '../agents/lookups.js';
import { PROMOTE_AT } from '../agents/discovery/score.js';

export const NO_REPLY_DAYS = 21;
export const FOLLOW_UP_DAYS = 14;
export const WEEKS = 12;

const RESPONSE_EMAILS = ['follow_up', 'interview_request', 'assessment', 'rejection', 'offer'];
const LINKED = "('auto', 'confirmed', 'reassigned')";
const DAY = 24 * 3600 * 1000;
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const earliest = (dates) => dates.filter(Boolean).sort()[0] ?? null;
const daysBetween = (a, b) => Math.max(0, Math.round((Date.parse(day(b)) - Date.parse(day(a))) / DAY));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rate = (n, d) => (d ? n / d : null);

/** Monday of the week containing the date (YYYY-MM-DD). */
function weekStart(iso) {
  const d = new Date(`${day(iso)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** One record per application, with each milestone: { reached, date } (date null when only undated evidence). */
export function applications(db, { now = new Date() } = {}) {
  const lk = lookups(db);
  const group = (status) => lk.groupOf('status', status);
  const history = new Map();
  for (const h of db.prepare('SELECT posting_id, to_status, changed_by, changed_at FROM status_history ORDER BY changed_at, id').all()) {
    history.set(h.posting_id, [...(history.get(h.posting_id) ?? []), h]);
  }
  const emails = new Map();
  for (const e of db.prepare(`SELECT posting_id, type, sent_at FROM emails WHERE posting_id IS NOT NULL AND review_status IN ${LINKED}`).all()) {
    emails.set(e.posting_id, [...(emails.get(e.posting_id) ?? []), e]);
  }

  const rows = db.prepare('SELECT id, company, title, source, track, status, stage, applied_on, discovered_on FROM postings').all();
  const out = [];
  for (const p of rows) {
    const hist = history.get(p.id) ?? [];
    const mail = emails.get(p.id) ?? [];
    const into = (pred) => hist.filter((h) => pred(h.to_status));
    const dated = (hs) => hs.filter((h) => h.changed_by !== 'import').map((h) => day(h.changed_at));
    const progressed = (s) => ['waiting', 'conversation', 'decision'].includes(group(s));
    const everProgressed = progressed(p.status) || hist.some((h) => progressed(h.to_status));
    const applied = Boolean(p.applied_on) || everProgressed || p.status === 'rejected' || hist.some((h) => h.to_status === 'rejected');
    if (!applied) continue;

    const appliedOn = day(p.applied_on) ?? earliest(dated(into((s) => group(s) === 'waiting'))) ?? earliest(dated(into(progressed))) ?? day(p.discovered_on);
    const milestone = (statusPred, emailTypes) => {
      const hs = into(statusPred);
      const ms = mail.filter((e) => emailTypes.includes(e.type));
      const reached = statusPred(p.status) || hs.length > 0 || ms.length > 0;
      return { reached, date: reached ? earliest([...dated(hs), ...ms.map((e) => day(e.sent_at))]) : null };
    };
    const interview = milestone((s) => group(s) === 'conversation', ['interview_request']);
    const offer = milestone((s) => group(s) === 'decision', ['offer']);
    const rejected = milestone((s) => s === 'rejected', ['rejection']);
    const responded = milestone((s) => ['conversation', 'decision'].includes(group(s)) || s === 'rejected', RESPONSE_EMAILS);
    const closed = lk.isClosed(p.status);
    const waitingDays = daysBetween(appliedOn, now.toISOString());
    out.push({
      id: p.id,
      company: p.company,
      title: p.title,
      source: p.source ?? 'unknown',
      track: p.track,
      status: p.status,
      appliedOn,
      responded,
      interview,
      offer,
      rejected,
      closed,
      waitingDays,
      noReply: !responded.reached && !closed && waitingDays >= NO_REPLY_DAYS,
    });
  }
  return out;
}

/**
 * The funnel for applications in the window.
 * @param {{ days?: number | null, track?: string | null, now?: Date }} opts  days: applied within the last N days (null: all)
 */
export function funnel(db, { days = null, track = null, now = new Date() } = {}) {
  const since = days ? new Date(now.getTime() - days * DAY).toISOString().slice(0, 10) : null;
  const inWindow = (a) => (!since || a.appliedOn >= since) && (!track || a.track === track);
  const apps = applications(db, { now }).filter(inWindow);

  const found = db
    .prepare(`SELECT COUNT(*) AS n,
        SUM(CASE WHEN (SELECT s.score FROM scores s WHERE s.posting_id = p.id ORDER BY CASE WHEN s.source IN ('v2', 'v2-rule') THEN 0 ELSE 1 END, s.id DESC LIMIT 1) >= ? THEN 1 ELSE 0 END) AS strong
      FROM postings p WHERE (? IS NULL OR p.discovered_on >= ?) AND (? IS NULL OR p.track = ?)`)
    .get(PROMOTE_AT, since, since, track, track);

  const count = (key) => apps.filter((a) => a[key].reached).length;
  const totals = {
    found: found.n,
    scored7: found.strong ?? 0,
    applied: apps.length,
    responded: count('responded'),
    interview: count('interview'),
    offer: count('offer'),
    rejected: count('rejected'),
    noReply: apps.filter((a) => a.noReply).length,
  };
  const timing = (key) => apps.filter((a) => a[key].date && a.appliedOn).map((a) => daysBetween(a.appliedOn, a[key].date));
  const toResponse = timing('responded');
  const toInterview = timing('interview');

  const bySource = new Map();
  for (const a of apps) {
    // Sources group case-insensitively ("manual" and "Manual" are one source).
    const key = a.source.trim().toLowerCase();
    const s = bySource.get(key) ?? { source: a.source.trim(), applied: 0, responded: 0, interview: 0, offer: 0 };
    s.applied += 1;
    s.responded += a.responded.reached ? 1 : 0;
    s.interview += a.interview.reached ? 1 : 0;
    s.offer += a.offer.reached ? 1 : 0;
    bySource.set(key, s);
  }

  const weeks = [];
  const thisWeek = weekStart(now.toISOString());
  for (let i = WEEKS - 1; i >= 0; i -= 1) {
    const w = new Date(`${thisWeek}T00:00:00Z`);
    w.setUTCDate(w.getUTCDate() - i * 7);
    weeks.push({ weekStart: w.toISOString().slice(0, 10), applied: 0 });
  }
  for (const a of applications(db, { now }).filter((x) => !track || x.track === track)) {
    const w = weeks.find((x) => x.weekStart === weekStart(a.appliedOn));
    if (w) w.applied += 1;
  }

  return {
    window: { days, since, track },
    totals,
    rates: { response: rate(totals.responded, totals.applied), interview: rate(totals.interview, totals.applied), offer: rate(totals.offer, totals.applied) },
    medians: { daysToResponse: median(toResponse), daysToInterview: median(toInterview), responseSamples: toResponse.length, interviewSamples: toInterview.length },
    bySource: [...bySource.values()].map((s) => ({ ...s, responseRate: rate(s.responded, s.applied) })).sort((a, b) => b.applied - a.applied || a.source.localeCompare(b.source)),
    weeks,
    followUps: apps
      .filter((a) => !a.responded.reached && !a.closed && a.waitingDays >= FOLLOW_UP_DAYS)
      .sort((a, b) => b.waitingDays - a.waitingDays)
      .map(({ id, company, title, appliedOn, waitingDays, status }) => ({ id, company, title, appliedOn, days: waitingDays, status })),
  };
}
