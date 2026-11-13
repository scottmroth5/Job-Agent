// The people who use the app (multi-user). The owner is user 1, an admin; migration 013 gave every existing row to them,
// and the addresses in AUTH_ALLOWED_EMAILS are always the owner's. Anyone else signs in with Google, requests access
// (pending), and the owner approves (active) or rejects them; an active account can be paused. How a user's Claude calls
// are paid for is ai_source: 'own' (their key, sealed in claude_key_enc by tools/secret-box.ts) or 'owner' (the owner's
// key, up to ai_cap_usd a month). Cross-user reads for the admin's Users screen are in server/admin-queries.ts.

import type { Db } from './engine/types.ts';
import type { UsersRow } from './types.ts';

export const OWNER_ID = 1;
export const USER_ROLES = ['admin', 'user'];
export const USER_STATUSES = ['active', 'pending', 'paused', 'rejected'];
export const AI_SOURCES = ['own', 'owner'];
export const MAX_NAME = 100;
export const MAX_NOTE = 1000;

const clean = (email: string | null | undefined) => String(email ?? '').trim().toLowerCase();

/** A user as getUser returns it: never the sealed key, only whether one is set. */
export type User = Omit<UsersRow, 'claude_key_enc' | 'updated_at' | 'last_seen_at' | 'time_zone' | 'decided_by'> & { has_key: boolean };

/** A user by id (never the sealed key: only whether one is set), or null. */
export async function getUser(db: Db, id: number): Promise<User | null> {
  const row = (await db
    .prepare(`SELECT id, email, name, role, status, request_note, terms_accepted_at, decided_at, ai_source, ai_cap_usd,
        claude_key_enc IS NOT NULL AS has_key, created_at FROM users WHERE id = ?`)
    .get(id)) as (Omit<User, 'has_key'> & { has_key: number }) | undefined;
  return row ? { ...row, has_key: Boolean(row.has_key) } : null;
}

/**
 * Who a signed-in address is: the owner for an AUTH_ALLOWED_EMAILS address, else its own users row, else null (not
 * registered yet). Returns { uid, status, role }.
 */
export async function accountFor(db: Db, email: string | null | undefined, ownerEmails: string[] = []) {
  const address = clean(email);
  if (!address) return null;
  if (ownerEmails.map(clean).includes(address)) return { uid: OWNER_ID, status: 'active', role: 'admin' };
  const row = (await db.prepare('SELECT id, status, role FROM users WHERE email = ?').get(address)) as Pick<UsersRow, 'id' | 'status' | 'role'> | undefined;
  return row ? { uid: row.id, status: row.status, role: row.role } : null;
}

/** Gives the owner's row their first allowed address, when it has none (so the Users screen shows it). */
export async function syncOwnerEmail(db: Db, ownerEmails: string[] = []) {
  const first = clean(ownerEmails[0]);
  if (!first) return;
  const q = db;
  await q.tx(async () => {
    const taken = await q.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(first, OWNER_ID);
    if (!taken) await q.prepare('UPDATE users SET email = ? WHERE id = ? AND email IS NULL').run(first, OWNER_ID);
  });
}

/** Adds a user directly (tests). Returns the new id. */
export async function addUser(
  db: Db,
  { email, name = null, role = 'user', status = 'active', aiSource = 'own', now = new Date() }: { email: string; name?: string | null; role?: string; status?: string; aiSource?: string; now?: Date },
) {
  const iso = now.toISOString();
  const r = await db
    .prepare('INSERT INTO users (email, name, role, status, ai_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .run(clean(email), name, role, status, aiSource, iso, iso);
  return Number(r.id);
}

/**
 * A request for access from a signed-in address with no account: a pending user. An address that already has a row
 * (pending, rejected, or anything else) is left as it is. Returns { id, created }. The check and the insert are one
 * transaction, so two requests from one address at once make one row.
 */
export async function requestAccess(
  db: Db,
  { email, name, note = null, now = new Date() }: { email: string; name?: string | null; note?: string | null; now?: Date },
) {
  const address = clean(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error('requestAccess needs a signed-in email address');
  const q = db;
  return q.tx(async () => {
    const existing = (await q.prepare('SELECT id FROM users WHERE email = ?').get(address)) as { id: number } | undefined;
    if (existing) return { id: existing.id, created: false };
    const who = String(name ?? '').trim().slice(0, MAX_NAME);
    if (!who) throw Object.assign(new Error('Please give your name.'), { statusCode: 400 });
    const iso = now.toISOString();
    const r = await q
      .prepare(`INSERT INTO users (email, name, role, status, request_note, terms_accepted_at, ai_source, created_at, updated_at)
      VALUES (?, ?, 'user', 'pending', ?, ?, 'own', ?, ?) RETURNING id`)
      .run(address, who, String(note ?? '').trim().slice(0, MAX_NOTE) || null, iso, iso, iso);
    return { id: Number(r.id), created: true };
  });
}

// Which status each decision may start from, and what it sets.
const DECISIONS: Record<string, { from: string[]; to: string }> = {
  approve: { from: ['pending', 'rejected'], to: 'active' },
  reject: { from: ['pending'], to: 'rejected' },
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
};
export const DECISION_NAMES = Object.keys(DECISIONS);

/**
 * Applies an admin's decision to a user (never the owner). Returns the updated user; throws a 400/404 otherwise. The
 * status check and the update are one transaction, so two decisions at once can not both pass the check.
 */
export async function decide(db: Db, id: number, decision: string, { by, now = new Date() }: { by: number | null; now?: Date }) {
  const rule = DECISIONS[decision];
  if (!rule) throw Object.assign(new Error('Unknown decision.'), { statusCode: 400 });
  const q = db;
  return q.tx(async () => {
    const user = await getUser(q, id);
    if (!user || id === OWNER_ID) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
    if (!rule.from.includes(user.status)) throw Object.assign(new Error(`A ${user.status} account cannot be ${decision.endsWith('e') ? `${decision}d` : `${decision}ed`}.`), { statusCode: 400 });
    const iso = now.toISOString();
    await q.prepare('UPDATE users SET status = ?, decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ?').run(rule.to, iso, by, iso, id);
    return getUser(q, id);
  });
}

/** How a user's Claude calls are paid for: their own key, or the owner's key up to capUsd a month. */
export async function setAiAccess(db: Db, id: number, { source, capUsd = null }: { source: string; capUsd?: unknown }, now = new Date()) {
  if (!AI_SOURCES.includes(source)) throw Object.assign(new Error('Choose their own key or yours.'), { statusCode: 400 });
  if (id === OWNER_ID) throw Object.assign(new Error('Your own AI always uses your key.'), { statusCode: 400 });
  const cap = source === 'owner' ? Number(capUsd) : null;
  if (source === 'owner' && !(Number.isFinite(cap) && (cap as number) > 0 && (cap as number) <= 10000)) {
    throw Object.assign(new Error('Give a monthly cap in dollars, above zero.'), { statusCode: 400 });
  }
  const { changes } = await db.prepare('UPDATE users SET ai_source = ?, ai_cap_usd = ?, updated_at = ? WHERE id = ?').run(source, cap, now.toISOString(), id);
  if (!changes) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
  return getUser(db, id);
}

/** Stores (sealed) or clears a user's own Claude key. */
export async function setClaudeKey(db: Db, id: number, sealed: string | null | undefined, now = new Date()) {
  await db.prepare('UPDATE users SET claude_key_enc = ?, updated_at = ? WHERE id = ?').run(sealed ?? null, now.toISOString(), id);
}

/** The sealed key, for the one call that opens it (tools/claude.ts). */
export const sealedClaudeKey = async (db: Db, id: number): Promise<string | null> =>
  ((await db.prepare('SELECT claude_key_enc FROM users WHERE id = ?').pluck().get(id)) as string | null | undefined) ?? null;

const SEEN_EVERY_MS = 15 * 60 * 1000;
const seenByDb = new WeakMap<object, Map<number, number>>(); // db -> (uid -> when last written), so a busy session writes at most every 15 minutes

/**
 * Records that a user was here (the Users screen's "last seen"); cheap to call on every request. The 15-minute check
 * and its mark happen before anything is awaited, so two requests at once write once.
 */
export async function touchLastSeen(db: Db, uid: number, now = new Date()) {
  if (!seenByDb.has(db)) seenByDb.set(db, new Map());
  const seen = seenByDb.get(db) as Map<number, number>;
  if (now.getTime() - (seen.get(uid) ?? 0) < SEEN_EVERY_MS) return;
  seen.set(uid, now.getTime());
  await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), uid);
}
