// The admin's cross-user reads (multi-user). The only place, with the migrations, that may query user tables across
// users (test/user-scope.test.js exempts this file): it reads the unscoped database, and its routes need the admin role.
// It returns account facts and counts only, never a user's jobs, notes, emails, background, or key.
import { MIN_PROFILE_CHARS, scheduledForUser, userConfig, userProfile } from '../agents/user-config.ts';
import { currentTimeZone, currentUserId, runAsUser } from '../db/scope.ts';
import { appDay, dayOf, localDay } from '../tools/dates.ts';
import type { Database } from '../tools/types.ts';

/** A row of the Users screen's query, before setup and lastRun are filled in. */
type UserListRow = {
  id: number;
  email: string | null;
  name: string | null;
  role: string;
  status: string;
  requestNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  aiSource: string;
  aiCapUsd: number | null;
  hasKey: number;
  jobs: number;
  spentUsd: number;
  lastSeenAt: string | null;
  lastRun: string | null;
};
/** One week's totals while they are counted. */
type WeekTotals = {
  weekEnding: string;
  seen: Set<number>;
  pipelineCompleted: number;
  pipelineFailed: number;
  jobsAdded: number;
  lettersWritten: number;
  prepsWritten: number;
  claudeSpendUsd: number;
  feedbackReceived: number;
};
type Count = Exclude<keyof WeekTotals, 'weekEnding' | 'seen'>;

/**
 * Every account with this month's Claude spend, how many jobs it has, when it was last here, its last pipeline run, and
 * how far its setup has got (search ready, About you long enough, key saved, on the schedule).
 */
export async function listUsers(db: Database, now = new Date()) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const rows = (db
    .prepare(`SELECT u.id, u.email, u.name, u.role, u.status, u.request_note AS requestNote, u.created_at AS createdAt,
        u.decided_at AS decidedAt, u.ai_source AS aiSource, u.ai_cap_usd AS aiCapUsd, u.claude_key_enc IS NOT NULL AS hasKey,
        (SELECT COUNT(*) FROM postings p WHERE p.user_id = u.id) AS jobs,
        (SELECT COALESCE(SUM(c.cost_usd), 0) FROM run_calls c JOIN runs r ON r.id = c.run_id
          WHERE r.user_id = u.id AND c.created_at >= ?) AS spentUsd,
        u.last_seen_at AS lastSeenAt,
        (SELECT r.status || '|' || r.started_at FROM runs r WHERE r.user_id = u.id AND r.name = 'pipeline' ORDER BY r.id DESC LIMIT 1) AS lastRun
      FROM users u
      ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, u.created_at`)
    .all(monthStart) as UserListRow[]);
  return Promise.all(
    rows.map(async (u) => {
      const [runStatus, runAt] = u.lastRun ? u.lastRun.split('|') : [null, null];
      const owner = u.id === 1;
      return {
        ...u,
        hasKey: Boolean(u.hasKey),
        owner,
        lastRun: runAt ? { status: runStatus, startedAt: runAt } : null,
        // The owner's search lives in their file and Google Doc, so there is nothing to show here for them.
        // u.name may be null, which userConfig takes as it always has (the cast only names the parameter's type).
        setup: owner
          ? null
          : { searchReady: (await userConfig(db, u.id, u.name as string)).ready, profileReady: (await userProfile(db, u.id)).length >= MIN_PROFILE_CHARS, scheduled: await scheduledForUser(db, u.id) },
      };
    }),
  );
}

/** Feedback from every user, open first, with who sent it. */
export function listFeedback(db: Database, { limit = 200 } = {}) {
  return db
    .prepare(`SELECT f.id, f.body, f.page, f.status, f.created_at AS createdAt, f.done_at AS doneAt, u.id AS userId, u.email, u.name
      FROM feedback f JOIN users u ON u.id = f.user_id
      ORDER BY CASE f.status WHEN 'open' THEN 0 ELSE 1 END, f.created_at DESC LIMIT ?`)
    .all(limit);
}

/** Marks one piece of feedback done. False when there is none open with that id. */
export const markFeedbackDone = (db: Database, id: string, now = new Date()) =>
  db.prepare("UPDATE feedback SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'").run(now.toISOString(), id).changes > 0;

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const sundayOf = (day: string) => addDays(day, -new Date(`${day}T00:00:00Z`).getUTCDay());
// Letters a person or the app wrote: v1 imports are not this app's work.
const LETTER_SOURCES = new Set(['v2', 'v2-revision', 'user']);

/**
 * The app's weekly totals across everyone, newest week first; weeks run Sunday to Saturday by local day, and the first
 * row is the current week so far. Each row: the Saturday it ends, accounts seen (this week: a last visit in it; earlier
 * weeks: accounts with a run or an added job, since only the latest visit is kept), pipeline runs completed and
 * failed, jobs added, cover letters written, meeting preps written, Claude spend (calls with a known price), and
 * feedback received. Counts only: never who, or anything about a job.
 */
export function usageByWeek(db: Database, options: { weeks?: number; now?: Date } = {}) {
  // The app's zone, not the asking admin's own (Settings): everyone sees the same weeks. A time zone comes only with a
  // request's or job's user, so there is a current user.
  return currentTimeZone() ? runAsUser(currentUserId() as number, () => weeklyTotals(db, options)) : weeklyTotals(db, options);
}

function weeklyTotals(db: Database, { weeks = 12, now = new Date() }: { weeks?: number; now?: Date }) {
  const thisWeek = sundayOf(localDay(now));
  const first = addDays(thisWeek, -7 * (weeks - 1));
  // A day early, so no time zone drops a row; rows are then placed by their local day.
  const since = new Date(`${addDays(first, -1)}T00:00:00Z`).toISOString();
  const rows = new Map<string, WeekTotals>();
  for (let i = 0; i < weeks; i += 1) {
    const weekStart = addDays(thisWeek, -7 * i);
    rows.set(weekStart, {
      weekEnding: addDays(weekStart, 6),
      seen: new Set(),
      pipelineCompleted: 0,
      pipelineFailed: 0,
      jobsAdded: 0,
      lettersWritten: 0,
      prepsWritten: 0,
      claudeSpendUsd: 0,
      feedbackReceived: 0,
    });
  }
  const current = rows.get(thisWeek) as WeekTotals; // the first row set above
  const weekOf = (at: string | null) => {
    const day = dayOf(at);
    return day && day >= first ? rows.get(sundayOf(day)) : null;
  };
  const add = (at: string | null, field: Count, amount = 1) => {
    const week = weekOf(at);
    if (week) week[field] += amount;
  };
  // Earlier weeks count accounts by what they did; the current week by the last visit (below).
  const did = (at: string | null, uid: number) => {
    const week = weekOf(at);
    if (week && week !== current) week.seen.add(uid);
  };

  for (const r of db.prepare('SELECT name, status, started_at AS at, user_id AS uid FROM runs WHERE started_at >= ?').all(since) as Array<{ name: string; status: string; at: string; uid: number }>) {
    did(r.at, r.uid);
    if (r.name !== 'pipeline') continue;
    if (['ok', 'partial'].includes(r.status)) add(r.at, 'pipelineCompleted');
    else if (r.status === 'failed') add(r.at, 'pipelineFailed');
  }
  for (const p of db.prepare('SELECT created_at AS at, user_id AS uid FROM postings WHERE created_at >= ?').all(since) as Array<{ at: string; uid: number }>) {
    did(p.at, p.uid);
    add(p.at, 'jobsAdded');
  }
  for (const a of db.prepare("SELECT source, created_at AS at FROM artifacts WHERE kind = 'cover_letter' AND created_at >= ?").all(since) as Array<{ source: string; at: string }>) {
    if (LETTER_SOURCES.has(a.source)) add(a.at, 'lettersWritten');
  }
  for (const m of db.prepare('SELECT created_at AS at FROM meeting_preps WHERE created_at >= ?').all(since) as Array<{ at: string }>) add(m.at, 'prepsWritten');
  for (const c of db.prepare('SELECT cost_usd AS cost, created_at AS at FROM run_calls WHERE cost_usd IS NOT NULL AND created_at >= ?').all(since) as Array<{ cost: number; at: string }>) {
    add(c.at, 'claudeSpendUsd', c.cost);
  }
  for (const f of db.prepare('SELECT created_at AS at FROM feedback WHERE created_at >= ?').all(since) as Array<{ at: string }>) add(f.at, 'feedbackReceived');
  for (const u of db.prepare('SELECT last_seen_at AS at, id AS uid FROM users WHERE last_seen_at >= ?').all(since) as Array<{ at: string; uid: number }>) {
    if (weekOf(u.at) === current) current.seen.add(u.uid);
  }

  return [...rows.values()].map(({ weekEnding, seen, claudeSpendUsd, ...counts }) => ({
    weekEnding,
    accountsSeen: seen.size,
    ...counts,
    claudeSpendUsd: Math.round(claudeSpendUsd * 100) / 100,
  }));
}

/**
 * The device, browser, location, and source totals (server/usage-totals.ts) from a day on: each dimension on its own, largest
 * first. Locations come back split ({ city, state, country }; unknown has empty parts). App-wide counts only.
 */
export function usageTotals(db: Database, { since }: { since: string }) {
  const rows = db
    .prepare('SELECT dimension, value, SUM(count) AS count FROM usage_totals WHERE day >= ? GROUP BY dimension, value ORDER BY count DESC, value')
    .all(since) as Array<{ dimension: string; value: string; count: number }>;
  const of = (dimension: string) => rows.filter((r) => r.dimension === dimension).map(({ value, count }) => ({ value, count }));
  return {
    devices: of('device'),
    browsers: of('browser'),
    locations: of('location').map(({ value, count }) => {
      const [city = '', state = '', country = ''] = value === 'unknown' ? [] : value.split(', ');
      return { city, state, country, count };
    }),
    sources: of('source'),
  };
}

/** The first day (a Sunday, app zone) of the last `weeks` weeks, as usageByWeek counts them. */
export const usagePeriodStart = (weeks: number, now = new Date()) => addDays(sundayOf(appDay(now)), -7 * (weeks - 1));

/** What waits for the admin: access requests and open feedback (the Home Admin tile). */
export const adminWaiting = (db: Database) => ({
  requests: db.prepare("SELECT COUNT(*) FROM users WHERE status = 'pending'").pluck().get() as number,
  feedback: db.prepare("SELECT COUNT(*) FROM feedback WHERE status = 'open'").pluck().get() as number,
});
