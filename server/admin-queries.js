// The admin's cross-user reads (multi-user). The only place, with the migrations, that may query user tables across
// users (test/user-scope.test.js exempts this file): it reads the unscoped database, and its routes need the admin role.
// It returns account facts and counts only, never a user's jobs, notes, emails, background, or key.
import { MIN_PROFILE_CHARS, scheduledForUser, userConfig, userProfile } from '../agents/user-config.js';
import { dayOf, localDay } from '../tools/dates.js';

/**
 * Every account with this month's Claude spend, how many jobs it has, when it was last here, its last pipeline run, and
 * how far its setup has got (search ready, About you long enough, key saved, on the schedule).
 */
export function listUsers(db, now = new Date()) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  return db
    .prepare(`SELECT u.id, u.email, u.name, u.role, u.status, u.request_note AS requestNote, u.created_at AS createdAt,
        u.decided_at AS decidedAt, u.ai_source AS aiSource, u.ai_cap_usd AS aiCapUsd, u.claude_key_enc IS NOT NULL AS hasKey,
        (SELECT COUNT(*) FROM postings p WHERE p.user_id = u.id) AS jobs,
        (SELECT COALESCE(SUM(c.cost_usd), 0) FROM run_calls c JOIN runs r ON r.id = c.run_id
          WHERE r.user_id = u.id AND c.created_at >= ?) AS spentUsd,
        u.last_seen_at AS lastSeenAt,
        (SELECT r.status || '|' || r.started_at FROM runs r WHERE r.user_id = u.id AND r.name = 'pipeline' ORDER BY r.id DESC LIMIT 1) AS lastRun
      FROM users u
      ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, u.created_at`)
    .all(monthStart)
    .map((u) => {
      const [runStatus, runAt] = u.lastRun ? u.lastRun.split('|') : [null, null];
      const owner = u.id === 1;
      return {
        ...u,
        hasKey: Boolean(u.hasKey),
        owner,
        lastRun: runAt ? { status: runStatus, startedAt: runAt } : null,
        // The owner's search lives in their file and Google Doc, so there is nothing to show here for them.
        setup: owner
          ? null
          : { searchReady: userConfig(db, u.id, u.name).ready, profileReady: userProfile(db, u.id).length >= MIN_PROFILE_CHARS, scheduled: scheduledForUser(db, u.id) },
      };
    });
}

/** Feedback from every user, open first, with who sent it. */
export function listFeedback(db, { limit = 200 } = {}) {
  return db
    .prepare(`SELECT f.id, f.body, f.page, f.status, f.created_at AS createdAt, f.done_at AS doneAt, u.id AS userId, u.email, u.name
      FROM feedback f JOIN users u ON u.id = f.user_id
      ORDER BY CASE f.status WHEN 'open' THEN 0 ELSE 1 END, f.created_at DESC LIMIT ?`)
    .all(limit);
}

/** Marks one piece of feedback done. False when there is none open with that id. */
export const markFeedbackDone = (db, id, now = new Date()) =>
  db.prepare("UPDATE feedback SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'").run(now.toISOString(), id).changes > 0;

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (day) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
// Letters a person or the app wrote: v1 imports are not this app's work.
const LETTER_SOURCES = new Set(['v2', 'v2-revision', 'user']);

/**
 * The app's weekly totals across everyone, newest week first (weeks start Monday, local days): pipeline runs completed
 * and failed, jobs added, cover letters written, meeting preps written, and accounts seen (any account with a run, job,
 * document, or visit that week). Counts only: never who, or anything about a job.
 */
export function usageByWeek(db, { weeks = 12, now = new Date() } = {}) {
  const thisWeek = mondayOf(localDay(now));
  const first = addDays(thisWeek, -7 * (weeks - 1));
  // A day early, so no time zone drops a row; rows are then placed by their local day.
  const since = new Date(`${addDays(first, -1)}T00:00:00Z`).toISOString();
  const rows = new Map();
  for (let i = 0; i < weeks; i += 1) {
    const weekStart = addDays(thisWeek, -7 * i);
    rows.set(weekStart, { weekStart, pipelineCompleted: 0, pipelineFailed: 0, jobsAdded: 0, lettersWritten: 0, prepsWritten: 0, seen: new Set() });
  }
  const add = (at, field, uid) => {
    const day = dayOf(at);
    const week = day && day >= first ? rows.get(mondayOf(day)) : null;
    if (!week) return;
    if (field) week[field] += 1;
    if (uid != null) week.seen.add(uid);
  };

  for (const r of db.prepare('SELECT name, status, started_at AS at, user_id AS uid FROM runs WHERE started_at >= ?').all(since)) {
    const field = r.name !== 'pipeline' ? null : ['ok', 'partial'].includes(r.status) ? 'pipelineCompleted' : r.status === 'failed' ? 'pipelineFailed' : null;
    add(r.at, field, r.uid);
  }
  for (const p of db.prepare('SELECT created_at AS at, user_id AS uid FROM postings WHERE created_at >= ?').all(since)) add(p.at, 'jobsAdded', p.uid);
  for (const a of db.prepare('SELECT kind, source, created_at AS at, user_id AS uid FROM artifacts WHERE created_at >= ?').all(since)) {
    add(a.at, a.kind === 'cover_letter' && LETTER_SOURCES.has(a.source) ? 'lettersWritten' : null, a.uid);
  }
  for (const m of db.prepare('SELECT created_at AS at, user_id AS uid FROM meeting_preps WHERE created_at >= ?').all(since)) add(m.at, 'prepsWritten', m.uid);
  for (const u of db.prepare('SELECT last_seen_at AS at, id AS uid FROM users WHERE last_seen_at >= ?').all(since)) add(u.at, null, u.uid);

  return [...rows.values()].map(({ seen, ...week }) => ({ ...week, accountsSeen: seen.size }));
}

/** What waits for the admin: access requests and open feedback (the Home Admin tile). */
export const adminWaiting = (db) => ({
  requests: db.prepare("SELECT COUNT(*) FROM users WHERE status = 'pending'").pluck().get(),
  feedback: db.prepare("SELECT COUNT(*) FROM feedback WHERE status = 'open'").pluck().get(),
});
