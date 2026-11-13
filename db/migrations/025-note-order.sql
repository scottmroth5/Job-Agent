-- A job's notes in the order they were written (v3 Phase 4). Notes often share a time: adding a note to a job whose old
-- plain-text notes are not entries yet turns that text into an entry at the same moment, just before the new note.
-- SQLite kept that order by rowid, which PostgreSQL does not have, so each note now carries its place among its job's
-- notes. Existing notes keep their order exactly (numbered by rowid); agents/notes.ts gives each new note the next one.
ALTER TABLE posting_notes ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
UPDATE posting_notes SET seq = rowid;
