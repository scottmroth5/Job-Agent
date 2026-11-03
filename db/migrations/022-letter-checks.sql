-- The fact check on each cover letter version (agents/hunt/verify-letter.js, agents/letter-checks.js): the claims the
-- letter makes about the candidate, each supported, unsupported, or contradicted by the knowledge doc and resume, and
-- which ones the user dismissed. A user table (db/user-tables.js), so export and account deletion cover it. A version
-- with no row has not been checked; 'failed' means the check could not run (the letter is never affected).
CREATE TABLE letter_checks (
  artifact_id INTEGER PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('checked', 'failed')),
  claims_json TEXT,
  model TEXT,
  prompt_version TEXT,
  run_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX letter_checks_user ON letter_checks(user_id);
