-- Scam warnings on job postings (agents/discovery/scam.ts): one row per job, written the first time it is scored with
-- text. The free rule signals always; the Claude judgment (likelihood, reasons, summary) only for jobs the rules
-- flagged ('none' for the rest). 'failed' means the Claude check could not run (the signals are kept). dismissed_at is
-- the user's "Not a scam". A warning only: scores, promotion, and letters never read it. A user table
-- (db/user-tables.ts), so export and account deletion cover it.
CREATE TABLE scam_checks (
  posting_id INTEGER PRIMARY KEY REFERENCES postings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('checked', 'failed')),
  likelihood TEXT NOT NULL CHECK (likelihood IN ('none', 'low', 'medium', 'high')),
  signals_json TEXT NOT NULL,
  reasons_json TEXT,
  summary TEXT,
  model TEXT,
  prompt_version TEXT,
  run_id INTEGER,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX scam_checks_user ON scam_checks(user_id);
-- New jobs only: jobs created before this moment are never checked.
INSERT OR IGNORE INTO app_settings (key, value, updated_at)
  VALUES ('scam_checks_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
