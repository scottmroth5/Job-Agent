// A user's own data, whole (multi-user, phase 6): export it, or delete it with the account. Both walk every user
// table (db/user-tables.js), so a table added later is covered without changing this file.
//   Export: every row that is theirs, plus their account (never their sealed Claude key) and their runs' spending. Email
//   bodies are left out (they are encrypted with the server's key and only exist for the owner's inbox anyway).
//   Delete: every row and attached file, then the account. Runs paid with their own key go too; runs paid with the
//   owner's key stay, stripped of their details and given to the owner, so the owner's monthly cap still counts them.
// The owner's account is never exported through here as "deleted", and can never be deleted.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { USER_TABLES } from '../db/user-tables.js';
import { OWNER_ID } from '../db/users.js';

// Columns never exported: encrypted with keys the user does not hold.
const HIDDEN = { emails: ['body_enc'] };
// Deleted first: rows that point at other user rows (postings last; its children also cascade).
const DELETE_ORDER = ['decision_log', 'reminders', 'emails', 'email_threads', 'contacts', 'attachments', 'meeting_preps', 'posting_notes', 'posting_sightings', 'scores', 'artifacts', 'status_history', 'prompt_versions', 'user_settings', 'feedback', 'postings'];

const ordered = () => [...DELETE_ORDER.filter((t) => USER_TABLES.includes(t)), ...USER_TABLES.filter((t) => !DELETE_ORDER.includes(t))];

/** Everything that is this user's, as one object (the Settings download). */
export function exportAccount(db, uid, now = new Date()) {
  const account = db
    .prepare(`SELECT id, email, name, role, status, request_note AS requestNote, terms_accepted_at AS termsAcceptedAt, ai_source AS aiSource,
        ai_cap_usd AS aiCapUsd, claude_key_enc IS NOT NULL AS claudeKeySaved, created_at AS createdAt FROM users WHERE id = ?`)
    .get(uid);
  if (!account) throw Object.assign(new Error('Account not found.'), { statusCode: 404 });
  const tables = {};
  for (const t of USER_TABLES) {
    const rows = db.prepare(`SELECT * FROM "${t}" WHERE user_id = ? ORDER BY rowid`).all(uid);
    tables[t] = rows.map((r) => {
      const copy = { ...r };
      for (const c of HIDDEN[t] ?? []) delete copy[c];
      return copy;
    });
  }
  const runs = db
    .prepare(`SELECT r.id, r.name, r.status, r.started_at AS startedAt, r.finished_at AS finishedAt, r.cost_usd AS costUsd,
        (SELECT COUNT(*) FROM run_calls c WHERE c.run_id = r.id) AS calls FROM runs r WHERE r.user_id = ? ORDER BY r.id`)
    .all(uid);
  return { app: 'Job Hunt', exportedAt: now.toISOString(), account: { ...account, claudeKeySaved: Boolean(account.claudeKeySaved) }, tables, runs };
}

/**
 * Deletes a user's account and everything that is theirs. Returns counts (rows by table, files). Throws for the owner.
 * @param {string} [attachmentsDir]  where attached files live (data/attachments)
 */
export function deleteAccount(db, uid, { attachmentsDir = null } = {}) {
  if (uid === OWNER_ID) throw Object.assign(new Error("The owner's account cannot be deleted."), { statusCode: 400 });
  const user = db.prepare('SELECT ai_source FROM users WHERE id = ?').get(uid);
  if (!user) throw Object.assign(new Error('Account not found.'), { statusCode: 404 });
  const postingIds = db.prepare('SELECT id FROM postings WHERE user_id = ?').pluck().all(uid);
  const counts = {};
  db.transaction(() => {
    for (const t of ordered()) counts[t] = db.prepare(`DELETE FROM "${t}" WHERE user_id = ?`).run(uid).changes;
    // Their runs: the owner's key paid for these (keep the cost, drop the details), or their own did (gone).
    const keepForOwner = user.ai_source === 'owner';
    counts.runs = keepForOwner
      ? db.prepare('UPDATE runs SET user_id = ?, meta = NULL, summary = NULL WHERE user_id = ?').run(OWNER_ID, uid).changes
      : db.prepare('DELETE FROM runs WHERE user_id = ?').run(uid).changes;
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
  })();
  // Attached files live in a folder per job id; the rows are gone, so the folders go too (after the commit).
  let files = 0;
  if (attachmentsDir) {
    for (const id of postingIds) {
      const dir = join(attachmentsDir, String(Number(id)));
      try {
        rmSync(dir, { recursive: true, force: true });
        files += 1;
      } catch {
        // already gone
      }
    }
  }
  return { ...counts, attachmentFolders: files };
}
