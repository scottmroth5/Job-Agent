// Notes become separate entries, each with its own created and updated dates (agents/notes.js). Every job's
// existing notes text becomes one entry marked 'earlier', because when it was written was never recorded.
// postings.notes stays, kept in step with the entries, for code that reads notes as one text.
// A migration keeps its own copy of what it runs: app code changes later (agents/notes.js queries gained user_id in
// 013), and an old migration must do on a fresh database exactly what it did when it was written.
import { randomUUID } from 'node:crypto';

function adoptNotesText(db, { source }) {
  const nowIso = new Date().toISOString();
  const rows = db.prepare(`SELECT id, notes FROM postings p WHERE TRIM(COALESCE(p.notes, '')) <> ''
    AND NOT EXISTS (SELECT 1 FROM posting_notes n WHERE n.posting_id = p.id)`).all();
  const insert = db.prepare('INSERT INTO posting_notes (id, posting_id, body, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of rows) insert.run(randomUUID(), r.id, r.notes.trim(), source, nowIso, nowIso);
}

export const id = '012-posting-notes';

export function up(db) {
  db.exec(`CREATE TABLE posting_notes (
    id TEXT PRIMARY KEY,
    posting_id INTEGER NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user', 'agent', 'earlier')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX posting_notes_posting ON posting_notes(posting_id, created_at);`);
  adoptNotesText(db, { source: 'earlier' });
}
