// Notes become separate entries, each with its own created and updated dates (agents/notes.js). Every job's
// existing notes text becomes one entry marked 'earlier', because when it was written was never recorded.
// postings.notes stays, kept in step with the entries, for code that reads notes as one text.
import { adoptNotesText } from '../../agents/notes.js';

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
