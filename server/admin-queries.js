// The admin's cross-user reads (multi-user). The only place, with the migrations, that may query user tables across
// users (test/user-scope.test.js exempts this file): it reads the unscoped database, and its routes need the admin role.
// It returns account facts and counts only, never a user's jobs, notes, emails, background, or key.
import { MIN_PROFILE_CHARS, scheduledForUser, userConfig, userProfile } from '../agents/user-config.js';

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

/** What waits for the admin: access requests and open feedback (the Home Admin tile). */
export const adminWaiting = (db) => ({
  requests: db.prepare("SELECT COUNT(*) FROM users WHERE status = 'pending'").pluck().get(),
  feedback: db.prepare("SELECT COUNT(*) FROM feedback WHERE status = 'open'").pluck().get(),
});
