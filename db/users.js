// The people who use the app (multi-user, phase 1). The owner is user 1, an admin; migration 013 gave every existing
// row to them. Until registration arrives (phase 2), every address in AUTH_ALLOWED_EMAILS signs in as the owner unless
// it has its own users row. Cross-user reads (an admin's list of users) belong in server/admin-queries.js only.

export const OWNER_ID = 1;
export const USER_ROLES = ['admin', 'user'];
export const USER_STATUSES = ['active', 'pending', 'paused'];

/** A user by id, or null. */
export function getUser(db, id) {
  return db.prepare('SELECT id, email, name, role, status FROM users WHERE id = ?').get(id) ?? null;
}

/**
 * The user an allowed, signed-in address acts as: its own active users row, else the owner (the allowlist holds the
 * owner's addresses until phase 2). Null for a row that is pending or paused.
 */
export function userForEmail(db, email) {
  const row = db.prepare('SELECT id, status FROM users WHERE email = ?').get(String(email ?? '').trim().toLowerCase());
  if (row) return row.status === 'active' ? row.id : null;
  return OWNER_ID;
}

/** Adds a user (tests and, from phase 2, registration). Returns the new id. */
export function addUser(db, { email, name = null, role = 'user', status = 'active', now = new Date() }) {
  const iso = now.toISOString();
  return Number(
    db.prepare('INSERT INTO users (email, name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(email).trim().toLowerCase(), name, role, status, iso, iso).lastInsertRowid,
  );
}
