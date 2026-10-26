// The admin's cross-user reads (multi-user). The only place, with the migrations, that may query user tables across
// users (test/user-scope.test.js exempts this file): it reads the unscoped database, and its routes need the admin role.
// It returns account facts and counts only, never a user's jobs, notes, emails, or key.

/** Every account with this month's Claude spend and how many jobs it has. */
export function listUsers(db, now = new Date()) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  return db
    .prepare(`SELECT u.id, u.email, u.name, u.role, u.status, u.request_note AS requestNote, u.created_at AS createdAt,
        u.decided_at AS decidedAt, u.ai_source AS aiSource, u.ai_cap_usd AS aiCapUsd, u.claude_key_enc IS NOT NULL AS hasKey,
        (SELECT COUNT(*) FROM postings p WHERE p.user_id = u.id) AS jobs,
        (SELECT COALESCE(SUM(c.cost_usd), 0) FROM run_calls c JOIN runs r ON r.id = c.run_id
          WHERE r.user_id = u.id AND c.created_at >= ?) AS spentUsd
      FROM users u
      ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, u.created_at`)
    .all(monthStart)
    .map((u) => ({ ...u, hasKey: Boolean(u.hasKey), owner: u.id === 1 }));
}
