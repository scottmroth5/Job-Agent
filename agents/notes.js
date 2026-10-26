// A job's notes: separate entries, each with when it was created and last edited. posting_notes is the source of
// truth; postings.notes keeps every entry's text (oldest first, one per line) so code that reads a job's notes as
// one text (scoring and letter prompts, cleanup checks) keeps working. Always change notes through this module.
//   source: 'user' (typed by the user), 'agent' (written by Job Agent), 'earlier' (notes from before entries existed,
//   whose dates are unknown)
import { randomUUID } from 'node:crypto';

export const NOTE_SOURCES = ['user', 'agent', 'earlier'];
export const MAX_NOTE_CHARS = 20000;

const toEntry = (r) => ({ id: r.id, postingId: r.posting_id, body: r.body, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at });

/** Rewrites postings.notes from the entries. */
function refresh(db, postingId, nowIso) {
  const text = db
    .prepare('SELECT body FROM posting_notes WHERE posting_id = ? AND user_id = @uid ORDER BY created_at, rowid')
    .pluck()
    .all(postingId)
    .join('\n');
  db.prepare(`UPDATE postings SET notes = ?${nowIso ? ', updated_at = ?' : ''} WHERE id = ? AND user_id = @uid`).run(...[text || null, ...(nowIso ? [nowIso] : []), postingId]);
}

/**
 * Turns notes written straight into postings.notes (before entries existed, or by an insert) into one entry, for
 * jobs that have notes text but no entries. With postingId, only that job.
 * @returns {number} entries created
 */
export function adoptNotesText(db, { postingId = null, source = 'earlier', now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const rows = db
    .prepare(`SELECT id, notes FROM postings p WHERE p.user_id = @uid AND TRIM(COALESCE(p.notes, '')) <> ''
      AND NOT EXISTS (SELECT 1 FROM posting_notes n WHERE n.posting_id = p.id AND n.user_id = p.user_id) ${postingId ? 'AND p.id = ?' : ''}`)
    .all(...(postingId ? [postingId] : []));
  const insert = db.prepare('INSERT INTO posting_notes (user_id, id, posting_id, body, source, created_at, updated_at) VALUES (@uid, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) insert.run(randomUUID(), r.id, r.notes.trim(), source, nowIso, nowIso);
  return rows.length;
}

/** A job's notes, newest first. */
export function listNotes(db, postingId) {
  return db.prepare('SELECT * FROM posting_notes WHERE posting_id = ? AND user_id = @uid ORDER BY created_at DESC, rowid DESC').all(postingId).map(toEntry);
}

const checkBody = (body) => {
  const text = String(body ?? '').trim();
  if (!text) throw Object.assign(new Error('A note needs some text.'), { statusCode: 400 });
  if (text.length > MAX_NOTE_CHARS) throw Object.assign(new Error(`A note can be at most ${MAX_NOTE_CHARS} characters.`), { statusCode: 400 });
  return text;
};

/** Adds a note to a job. */
export function addNote(db, postingId, body, { source = 'user', now = new Date() } = {}) {
  const text = checkBody(body);
  if (!NOTE_SOURCES.includes(source)) throw new Error(`Unknown note source: ${source}`);
  const nowIso = now.toISOString();
  const id = randomUUID();
  db.transaction(() => {
    adoptNotesText(db, { postingId, now });
    // The note takes its owner from the job, so a job that is not this user's gets no note.
    const added = db
      .prepare('INSERT INTO posting_notes (user_id, id, posting_id, body, source, created_at, updated_at) SELECT user_id, ?, id, ?, ?, ?, ? FROM postings WHERE id = ? AND user_id = @uid')
      .run(id, text, source, nowIso, nowIso, postingId);
    if (!added.changes) throw Object.assign(new Error('Job not found.'), { statusCode: 404 });
    refresh(db, postingId, nowIso);
  })();
  return toEntry(db.prepare('SELECT * FROM posting_notes WHERE id = ? AND user_id = @uid').get(id));
}

/** Edits a note's text; its created date stays, its updated date moves. Null when there is no such note. */
export function updateNote(db, noteId, body, { now = new Date() } = {}) {
  const text = checkBody(body);
  const row = db.prepare('SELECT * FROM posting_notes WHERE id = ? AND user_id = @uid').get(noteId);
  if (!row) return null;
  if (text === row.body) return toEntry(row);
  const nowIso = now.toISOString();
  db.transaction(() => {
    db.prepare('UPDATE posting_notes SET body = ?, updated_at = ? WHERE id = ? AND user_id = @uid').run(text, nowIso, noteId);
    refresh(db, row.posting_id, nowIso);
  })();
  return toEntry(db.prepare('SELECT * FROM posting_notes WHERE id = ? AND user_id = @uid').get(noteId));
}

/** Deletes a note. False when there is no such note. */
export function deleteNote(db, noteId, { now = new Date() } = {}) {
  const row = db.prepare('SELECT posting_id FROM posting_notes WHERE id = ? AND user_id = @uid').get(noteId);
  if (!row) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM posting_notes WHERE id = ? AND user_id = @uid').run(noteId);
    refresh(db, row.posting_id, now.toISOString());
  })();
  return true;
}

const day = (iso) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

/** A job's notes for a prompt: oldest first, each with its date, so Claude can tell what is recent. */
export function notesForPrompt(entries) {
  return [...entries]
    .reverse()
    .map((n) => {
      const when = n.source === 'earlier' ? `Earlier note (before ${day(n.createdAt)})` : `Note from ${day(n.createdAt)}${n.updatedAt.slice(0, 10) !== n.createdAt.slice(0, 10) ? `, edited ${day(n.updatedAt)}` : ''}`;
      return `${when}${n.source === 'agent' ? ', added by Job Agent' : ''}:\n${n.body}`;
    })
    .join('\n\n');
}
