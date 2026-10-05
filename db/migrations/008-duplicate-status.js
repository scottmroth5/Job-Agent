// Adds the 'duplicate' status to postings. SQLite cannot alter a CHECK constraint, and rebuilding postings is
// unsafe here: migrations run in a transaction with foreign keys on, so the rebuild would repoint and then
// cascade-delete scores, letters, and history. Instead this uses SQLite's documented in-place schema edit
// (writable_schema), which is safe for loosening a constraint: every existing row already satisfies the new
// list. better-sqlite3's unsafe mode lifts defensive mode for just this edit. Any failure rolls back.
//
// It also turns copies that npm run cleanup archived as "passed" (with a "duplicate of #N" note) into
// 'duplicate', so the status says what they are.

export const id = '008-duplicate-status';

const OLD = "'passed', 'closed', 'rejected')";
const NEW = "'passed', 'closed', 'rejected', 'duplicate')";

export function up(db) {
  const createSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'postings'").pluck().get();
  if (createSql?.includes(NEW)) return;
  if (!createSql?.includes(OLD) || createSql.split(OLD).length !== 2) {
    throw new Error('008: the postings status constraint is not in the expected form; nothing was changed.');
  }

  const version = db.pragma('schema_version', { simple: true });
  db.unsafeMode(true);
  try {
    db.pragma('writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'postings'").run(createSql.replace(OLD, NEW));
    db.pragma(`schema_version = ${version + 1}`);
    db.pragma('writable_schema = OFF');
  } finally {
    db.unsafeMode(false);
  }
  const check = db.pragma('integrity_check', { simple: true });
  if (check !== 'ok') throw new Error(`008: integrity check failed after the schema edit (${check}); rolled back.`);

  // Copies the cleanup archived as passed become 'duplicate' (only when that passed status was the agent's).
  const now = new Date().toISOString();
  const copies = db
    .prepare(`SELECT p.id FROM postings p WHERE p.status = 'passed' AND p.notes LIKE '%: duplicate of #%'
      AND (SELECT h.changed_by FROM status_history h WHERE h.posting_id = p.id ORDER BY h.id DESC LIMIT 1) = 'agent'`)
    .pluck()
    .all();
  const set = db.prepare("UPDATE postings SET status = 'duplicate', updated_at = ? WHERE id = ?");
  const log = db.prepare("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, 'passed', 'duplicate', 'agent', ?)");
  for (const pid of copies) {
    set.run(now, pid);
    log.run(pid, now);
  }
}
