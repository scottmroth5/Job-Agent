// The people who use the app (multi-user). The owner is user 1, an admin; migration 013 gave every existing row to them,
// and the addresses in AUTH_ALLOWED_EMAILS are always the owner's. Anyone else signs in with Google, requests access
// (pending), and the owner approves (active) or rejects them; an active account can be paused. How a user's Claude calls
// are paid for is ai_source: 'own' (their key, sealed in claude_key_enc by tools/secret-box.js) or 'owner' (the owner's
// key, up to ai_cap_usd a month). Cross-user reads for the admin's Users screen are in server/admin-queries.js.

export const OWNER_ID = 1;
export const USER_ROLES = ['admin', 'user'];
export const USER_STATUSES = ['active', 'pending', 'paused', 'rejected'];
export const AI_SOURCES = ['own', 'owner'];
export const MAX_NAME = 100;
export const MAX_NOTE = 1000;

const clean = (email) => String(email ?? '').trim().toLowerCase();

/** A user by id (never the sealed key: only whether one is set), or null. */
export function getUser(db, id) {
  const row = db
    .prepare(`SELECT id, email, name, role, status, request_note, terms_accepted_at, decided_at, ai_source, ai_cap_usd,
        claude_key_enc IS NOT NULL AS has_key, created_at FROM users WHERE id = ?`)
    .get(id);
  return row ? { ...row, has_key: Boolean(row.has_key) } : null;
}

/**
 * Who a signed-in address is: the owner for an AUTH_ALLOWED_EMAILS address, else its own users row, else null (not
 * registered yet). Returns { uid, status, role }.
 */
export function accountFor(db, email, ownerEmails = []) {
  const address = clean(email);
  if (!address) return null;
  if (ownerEmails.map(clean).includes(address)) return { uid: OWNER_ID, status: 'active', role: 'admin' };
  const row = db.prepare('SELECT id, status, role FROM users WHERE email = ?').get(address);
  return row ? { uid: row.id, status: row.status, role: row.role } : null;
}

/** Gives the owner's row their first allowed address, when it has none (so the Users screen shows it). */
export function syncOwnerEmail(db, ownerEmails = []) {
  const first = clean(ownerEmails[0]);
  if (!first) return;
  const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(first, OWNER_ID);
  if (!taken) db.prepare('UPDATE users SET email = ? WHERE id = ? AND email IS NULL').run(first, OWNER_ID);
}

/** Adds a user directly (tests). Returns the new id. */
export function addUser(db, { email, name = null, role = 'user', status = 'active', aiSource = 'own', now = new Date() }) {
  const iso = now.toISOString();
  return Number(
    db.prepare('INSERT INTO users (email, name, role, status, ai_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(clean(email), name, role, status, aiSource, iso, iso).lastInsertRowid,
  );
}

/**
 * A request for access from a signed-in address with no account: a pending user. An address that already has a row
 * (pending, rejected, or anything else) is left as it is. Returns { id, created }.
 */
export function requestAccess(db, { email, name, note = null, now = new Date() }) {
  const address = clean(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error('requestAccess needs a signed-in email address');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(address);
  if (existing) return { id: existing.id, created: false };
  const who = String(name ?? '').trim().slice(0, MAX_NAME);
  if (!who) throw Object.assign(new Error('Please give your name.'), { statusCode: 400 });
  const iso = now.toISOString();
  const id = Number(
    db.prepare(`INSERT INTO users (email, name, role, status, request_note, terms_accepted_at, ai_source, created_at, updated_at)
      VALUES (?, ?, 'user', 'pending', ?, ?, 'own', ?, ?)`)
      .run(address, who, String(note ?? '').trim().slice(0, MAX_NOTE) || null, iso, iso, iso).lastInsertRowid,
  );
  return { id, created: true };
}

// Which status each decision may start from, and what it sets.
const DECISIONS = {
  approve: { from: ['pending', 'rejected'], to: 'active' },
  reject: { from: ['pending'], to: 'rejected' },
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
};
export const DECISION_NAMES = Object.keys(DECISIONS);

/** Applies an admin's decision to a user (never the owner). Returns the updated user; throws a 400/404 otherwise. */
export function decide(db, id, decision, { by, now = new Date() }) {
  const rule = DECISIONS[decision];
  if (!rule) throw Object.assign(new Error('Unknown decision.'), { statusCode: 400 });
  const user = getUser(db, id);
  if (!user || id === OWNER_ID) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
  if (!rule.from.includes(user.status)) throw Object.assign(new Error(`A ${user.status} account cannot be ${decision}d.`), { statusCode: 400 });
  const iso = now.toISOString();
  db.prepare('UPDATE users SET status = ?, decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ?').run(rule.to, iso, by, iso, id);
  return getUser(db, id);
}

/** How a user's Claude calls are paid for: their own key, or the owner's key up to capUsd a month. */
export function setAiAccess(db, id, { source, capUsd = null }, now = new Date()) {
  if (!AI_SOURCES.includes(source)) throw Object.assign(new Error('Choose their own key or yours.'), { statusCode: 400 });
  if (id === OWNER_ID) throw Object.assign(new Error('Your own AI always uses your key.'), { statusCode: 400 });
  const cap = source === 'owner' ? Number(capUsd) : null;
  if (source === 'owner' && !(Number.isFinite(cap) && cap > 0 && cap <= 10000)) {
    throw Object.assign(new Error('Give a monthly cap in dollars, above zero.'), { statusCode: 400 });
  }
  const changes = db.prepare('UPDATE users SET ai_source = ?, ai_cap_usd = ?, updated_at = ? WHERE id = ?').run(source, cap, now.toISOString(), id).changes;
  if (!changes) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
  return getUser(db, id);
}

/** Stores (sealed) or clears a user's own Claude key. */
export function setClaudeKey(db, id, sealed, now = new Date()) {
  db.prepare('UPDATE users SET claude_key_enc = ?, updated_at = ? WHERE id = ?').run(sealed ?? null, now.toISOString(), id);
}

/** The sealed key, for the one call that opens it (tools/claude.js). */
export const sealedClaudeKey = (db, id) => db.prepare('SELECT claude_key_enc FROM users WHERE id = ?').pluck().get(id) ?? null;
