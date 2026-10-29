// Following up on applications sent through a careers site or job board, with nobody contacted yet. An application
// with no reply is worth a follow-up from FOLLOW_UP_FROM days until the user's stale-application days (Settings >
// Follow-ups, DEFAULT_STALE_DAYS), and never once archived; from then on it is stale: close it as no response (one job,
// or every stale one at once) rather than chase it. Closing uses the status list's noResponse role ("No response", a
// closed status), with a note and the user's status history, so the funnel still counts the application.
import { getUserSetting, setUserSetting } from '../db/settings.js';
import { lookups } from './lookups.js';
import { addNote } from './notes.js';
import { localDay } from '../tools/dates.js';
import { applications, DEFAULT_STALE_DAYS, FOLLOW_UP_DAYS } from '../server/funnel.js';

export { DEFAULT_STALE_DAYS };
export const FOLLOW_UP_FROM = FOLLOW_UP_DAYS;
export const MIN_STALE_DAYS = 14;
export const MAX_STALE_DAYS = 365;
const KEY = 'followUp.staleDays';

/** The current user's stale-application days (Settings), else DEFAULT_STALE_DAYS. */
export function staleDays(db) {
  const n = Number(getUserSetting(db, KEY));
  return Number.isInteger(n) && n >= MIN_STALE_DAYS && n <= MAX_STALE_DAYS ? n : DEFAULT_STALE_DAYS;
}

export function setStaleDays(db, days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < MIN_STALE_DAYS || n > MAX_STALE_DAYS) {
    throw Object.assign(new Error(`Choose a whole number of days from ${MIN_STALE_DAYS} to ${MAX_STALE_DAYS}.`), { statusCode: 400 });
  }
  setUserSetting(db, KEY, String(n));
  return n;
}

/**
 * The current user's applications still waiting for a reply, split: followUp (FOLLOW_UP_FROM days up to the stale days,
 * not archived) and stale (the stale days or more, archived or not), each oldest first.
 */
export function waitingApplications(db, { now = new Date(), stale = staleDays(db) } = {}) {
  const archived = lookups(db).ids('stage', 'archived');
  const waiting = applications(db, { now })
    .filter((a) => !a.responded.reached && !a.closed)
    .sort((a, b) => b.waitingDays - a.waitingDays);
  return {
    staleDays: stale,
    followUp: waiting.filter((a) => a.waitingDays >= FOLLOW_UP_FROM && a.waitingDays < stale && !archived.includes(a.stage)),
    stale: waiting.filter((a) => a.waitingDays >= stale),
  };
}

/**
 * Closes applications as no response (the noResponse role's status): ids, or every stale one when ids is null. Only
 * applications still waiting (no reply, not closed) are changed. Returns the ones closed: [{ id, company, title, days }].
 */
export function closeNoResponse(db, { ids = null, now = new Date(), dryRun = false } = {}) {
  const lk = lookups(db);
  const status = lk.role('status', 'noResponse') ?? lk.ids('status', 'closed')[0];
  const { stale } = waitingApplications(db, { now });
  const pick = ids ? new Set(ids.map(Number)) : null;
  const targets = pick ? applications(db, { now }).filter((a) => pick.has(a.id) && !a.responded.reached && !a.closed) : stale;
  if (!dryRun && targets.length) {
    const nowIso = now.toISOString();
    const update = db.prepare('UPDATE postings SET status = ?, updated_at = ? WHERE id = ? AND user_id = @uid');
    const history = db.prepare("INSERT INTO status_history (user_id, posting_id, from_status, to_status, changed_by, changed_at) VALUES (@uid, ?, ?, ?, 'user', ?)");
    db.transaction(() => {
      for (const a of targets) {
        update.run(status, nowIso, a.id);
        history.run(a.id, a.status, status, nowIso);
        addNote(db, a.id, `Closed ${localDay(now)}: no reply ${a.waitingDays} days after applying (${lk.label('status', status)}).`, { source: 'agent', now });
      }
    })();
  }
  return targets.map((a) => ({ id: a.id, company: a.company, title: a.title, days: a.waitingDays }));
}
