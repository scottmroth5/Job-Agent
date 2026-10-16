-- Meeting prep documents for a job: who the meeting is with, what the user added, and the written prep
-- (Markdown). The Google Doc copy, when made, is linked by doc_id/doc_url.
CREATE TABLE meeting_preps (
  id TEXT PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  attendees_json TEXT NOT NULL,
  meeting_at TEXT,
  meeting_kind TEXT,
  meeting_format TEXT,
  context TEXT,
  research INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  doc_id TEXT,
  doc_url TEXT,
  doc_name TEXT,
  model TEXT NOT NULL,
  prompt_version TEXT,
  cost_usd REAL,
  web_searches INTEGER NOT NULL DEFAULT 0,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX meeting_preps_posting ON meeting_preps(posting_id, created_at);
