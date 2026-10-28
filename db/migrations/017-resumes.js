// Resumes each user uploads in Settings: the file itself (kept in the database, so the encrypted backup, Download my
// data, and account deletion cover it like every other row) and its text, which letters, resume tweaks, and meeting
// prep read. titles are plain words matched against a job title to pick the resume for that job; one may be the
// default. Artifacts and meeting preps record which resume they were written from.

export const id = '017-resumes';

export function up(db) {
  db.exec(`CREATE TABLE resumes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      label TEXT NOT NULL,
      titles TEXT NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      filename TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('pdf', 'docx', 'text')),
      size_bytes INTEGER NOT NULL,
      file BLOB NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX resumes_user ON resumes(user_id, created_at);
    ALTER TABLE artifacts ADD COLUMN resume_id TEXT;
    ALTER TABLE meeting_preps ADD COLUMN resume_id TEXT;`);
}
