-- Files attached to a job (a tailored resume, the posting as a PDF, an offer letter). The bytes live on disk
-- under data/attachments/<posting id>/<attachment id>, named by ID only; this table holds what the file is.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX attachments_posting ON attachments(posting_id, created_at);
