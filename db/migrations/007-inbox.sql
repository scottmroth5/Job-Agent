-- Gmail inbox integration (agents/inbox). Portable types only, so the schema moves to PostgreSQL cleanly:
-- TEXT UUID keys, TEXT ISO-8601 UTC timestamps, REAL, JSON as TEXT; no AUTOINCREMENT or booleans.
-- postings stays the application record; new tables point at postings.id.

-- The employer's own email domain, learned from matched mail (never an ATS or job-board domain).
ALTER TABLE postings ADD COLUMN company_domain TEXT;
CREATE INDEX postings_company_domain ON postings(company_domain);

-- People who wrote about an application (recruiters, hiring managers).
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  company TEXT,
  posting_id INTEGER REFERENCES postings(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('email', 'user')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Gmail threads already tied to an application, so replies match by thread.
CREATE TABLE email_threads (
  thread_id TEXT PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('application', 'outreach')),
  created_at TEXT NOT NULL
);

-- Every email that passed the pre-filter. Bodies are kept only for matched emails, encrypted.
CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  gmail_message_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  subject TEXT,
  type TEXT CHECK (type IN ('confirmation', 'rejection', 'recruiter_outreach', 'interview_request', 'assessment', 'offer', 'follow_up', 'other')),
  posting_id INTEGER REFERENCES postings(id) ON DELETE SET NULL,
  match_rule TEXT CHECK (match_rule IN ('thread', 'contact', 'domain', 'ats_subject', 'model', 'user')),
  confidence REAL,
  review_status TEXT NOT NULL CHECK (review_status IN ('auto', 'needs_review', 'confirmed', 'reassigned', 'not_job', 'new_opportunity')),
  review_reason TEXT,
  summary TEXT,
  extracted_json TEXT,
  body_enc TEXT,
  prompt_version TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX emails_posting ON emails(posting_id, sent_at);
CREATE INDEX emails_review ON emails(review_status);
CREATE INDEX emails_thread ON emails(thread_id);

-- Why each automatic or reviewed change happened: the email, the rule or model, and the prompt version.
CREATE TABLE decision_log (
  id TEXT PRIMARY KEY,
  posting_id INTEGER REFERENCES postings(id) ON DELETE SET NULL,
  email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
  gmail_message_id TEXT,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  decided_by TEXT NOT NULL,
  prompt_version TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX decision_log_posting ON decision_log(posting_id, created_at);

-- Deadlines from assessments and scheduled interviews.
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  posting_id INTEGER REFERENCES postings(id) ON DELETE CASCADE,
  email_id TEXT REFERENCES emails(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assessment', 'interview')),
  due_at TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  created_at TEXT NOT NULL
);

-- Funnel dates per application, from the emails linked to it.
CREATE VIEW application_funnel AS
SELECT p.id AS posting_id, p.company, p.title, p.applied_on,
  MIN(CASE WHEN e.type = 'confirmation' THEN e.sent_at END) AS received_at,
  MIN(CASE WHEN e.type IN ('confirmation', 'follow_up', 'interview_request', 'assessment', 'rejection', 'offer') THEN e.sent_at END) AS first_response_at,
  MIN(CASE WHEN e.type = 'assessment' THEN e.sent_at END) AS screen_at,
  MIN(CASE WHEN e.type = 'interview_request' THEN e.sent_at END) AS interview_at,
  MIN(CASE WHEN e.type = 'rejection' THEN e.sent_at END) AS rejected_at,
  MIN(CASE WHEN e.type = 'offer' THEN e.sent_at END) AS offer_at
FROM postings p
JOIN emails e ON e.posting_id = p.id AND e.review_status IN ('auto', 'confirmed', 'reassigned')
GROUP BY p.id, p.company, p.title, p.applied_on;
