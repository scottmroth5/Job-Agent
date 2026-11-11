// A job's notes: separate entries, each with when it was created and last edited. posting_notes is the source of
// truth; postings.notes keeps every entry's text (oldest first, one per line) so code that reads a job's notes as
// one text (scoring and letter prompts, cleanup checks) keeps working. Always change notes through this module.
//   source: 'user' (typed by the user), 'agent' (written by Job Agent), 'earlier' (notes from before entries existed,
//   whose dates are unknown)
import { randomUUID } from 'node:crypto';
import { asEngine } from '../db/engine/index.ts';
import type { AnyDb } from '../db/engine/index.ts';
import type { Db } from '../db/engine/types.ts';
import type { PostingNotesRow } from '../db/types.ts';

/** A note as the app shows it. */
export interface Note {
  id: string;
  postingId: number;
  body: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export const NOTE_SOURCES = ['user', 'agent', 'earlier'];
export const MAX_NOTE_CHARS = 20000;

const toEntry = (r: PostingNotesRow): Note => ({ id: r.id, postingId: r.posting_id, body: r.body, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at });

/** Rewrites postings.notes from the entries. */
async function refresh(q: Db, postingId: number, nowIso: string | null) {
  const text = ((await q
    .prepare('SELECT body FROM posting_notes WHERE posting_id = ? AND user_id = @uid ORDER BY created_at, rowid')
    .pluck()
    .all(postingId)) as string[])
    .join('\n');
  await q.prepare(`UPDATE postings SET notes = ?${nowIso ? ', updated_at = ?' : ''} WHERE id = ? AND user_id = @uid`).run(...[text || null, ...(nowIso ? [nowIso] : []), postingId]);
}

/**
 * Turns notes written straight into postings.notes (before entries existed, or by an insert) into one entry, for
 * jobs that have notes text but no entries. With postingId, only that job. The check and the inserts are one
 * transaction (a savepoint inside a caller's), so two calls at once adopt a job's text once.
 * Returns how many entries were created.
 */
export async function adoptNotesText(db: AnyDb, { postingId = null, source = 'earlier', now = new Date() }: { postingId?: number | null; source?: string; now?: Date } = {}) {
  const nowIso = now.toISOString();
  const q = asEngine(db);
  return q.tx(async () => {
    const rows = (await q
      .prepare(`SELECT id, notes FROM postings p WHERE p.user_id = @uid AND TRIM(COALESCE(p.notes, '')) <> ''
      AND NOT EXISTS (SELECT 1 FROM posting_notes n WHERE n.posting_id = p.id AND n.user_id = p.user_id) ${postingId ? 'AND p.id = ?' : ''}`)
      .all(...(postingId ? [postingId] : []))) as Array<{ id: number; notes: string }>;
    const insert = q.prepare('INSERT INTO posting_notes (user_id, id, posting_id, body, source, created_at, updated_at) VALUES (@uid, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) await insert.run(randomUUID(), r.id, r.notes.trim(), source, nowIso, nowIso);
    return rows.length;
  });
}

/** A job's notes, newest first. */
export async function listNotes(db: AnyDb, postingId: number) {
  return ((await asEngine(db).prepare('SELECT * FROM posting_notes WHERE posting_id = ? AND user_id = @uid ORDER BY created_at DESC, rowid DESC').all(postingId)) as PostingNotesRow[]).map(toEntry);
}

const checkBody = (body: unknown) => {
  const text = String(body ?? '').trim();
  if (!text) throw Object.assign(new Error('A note needs some text.'), { statusCode: 400 });
  if (text.length > MAX_NOTE_CHARS) throw Object.assign(new Error(`A note can be at most ${MAX_NOTE_CHARS} characters.`), { statusCode: 400 });
  return text;
};

/** Adds a note to a job. */
export async function addNote(db: AnyDb, postingId: number, body: unknown, { source = 'user', now = new Date() }: { source?: string; now?: Date } = {}) {
  const text = checkBody(body);
  if (!NOTE_SOURCES.includes(source)) throw new Error(`Unknown note source: ${source}`);
  const nowIso = now.toISOString();
  const id = randomUUID();
  const q = asEngine(db);
  return q.tx(async () => {
    await adoptNotesText(q, { postingId, now });
    // The note takes its owner from the job, so a job that is not this user's gets no note.
    const added = await q
      .prepare('INSERT INTO posting_notes (user_id, id, posting_id, body, source, created_at, updated_at) SELECT user_id, ?, id, ?, ?, ?, ? FROM postings WHERE id = ? AND user_id = @uid')
      .run(id, text, source, nowIso, nowIso, postingId);
    if (!added.changes) throw Object.assign(new Error('Job not found.'), { statusCode: 404 });
    await refresh(q, postingId, nowIso);
    return toEntry((await q.prepare('SELECT * FROM posting_notes WHERE id = ? AND user_id = @uid').get(id)) as PostingNotesRow);
  });
}

/**
 * Edits a note's text; its created date stays, its updated date moves. Null when there is no such note. The read and
 * the write are one transaction.
 */
export async function updateNote(db: AnyDb, noteId: string, body: unknown, { now = new Date() }: { now?: Date } = {}) {
  const text = checkBody(body);
  const q = asEngine(db);
  return q.tx(async () => {
    const row = (await q.prepare('SELECT * FROM posting_notes WHERE id = ? AND user_id = @uid').get(noteId)) as PostingNotesRow | undefined;
    if (!row) return null;
    if (text === row.body) return toEntry(row);
    const nowIso = now.toISOString();
    await q.prepare('UPDATE posting_notes SET body = ?, updated_at = ? WHERE id = ? AND user_id = @uid').run(text, nowIso, noteId);
    await refresh(q, row.posting_id, nowIso);
    return toEntry((await q.prepare('SELECT * FROM posting_notes WHERE id = ? AND user_id = @uid').get(noteId)) as PostingNotesRow);
  });
}

/** Deletes a note. False when there is no such note. The read and the delete are one transaction. */
export async function deleteNote(db: AnyDb, noteId: string, { now = new Date() }: { now?: Date } = {}) {
  const q = asEngine(db);
  return q.tx(async () => {
    const row = (await q.prepare('SELECT posting_id FROM posting_notes WHERE id = ? AND user_id = @uid').get(noteId)) as { posting_id: number } | undefined;
    if (!row) return false;
    await q.prepare('DELETE FROM posting_notes WHERE id = ? AND user_id = @uid').run(noteId);
    await refresh(q, row.posting_id, now.toISOString());
    return true;
  });
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

/** A job's notes for a prompt: oldest first, each with its date, so Claude can tell what is recent. */
export function notesForPrompt(entries: Note[]) {
  return [...entries]
    .reverse()
    .map((n) => {
      const when = n.source === 'earlier' ? `Earlier note (before ${day(n.createdAt)})` : `Note from ${day(n.createdAt)}${n.updatedAt.slice(0, 10) !== n.createdAt.slice(0, 10) ? `, edited ${day(n.updatedAt)}` : ''}`;
      return `${when}${n.source === 'agent' ? ', added by Job Agent' : ''}:\n${n.body}`;
    })
    .join('\n\n');
}
