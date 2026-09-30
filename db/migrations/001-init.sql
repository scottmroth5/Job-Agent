-- One row per job. stage replaces v1's two sheets; status replaces the Status column.
CREATE TABLE postings (
  id INTEGER PRIMARY KEY,
  url TEXT,
  url_key TEXT UNIQUE,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  company_title_key TEXT NOT NULL,
  source TEXT,
  location TEXT,
  salary TEXT,
  job_type TEXT,
  posted_on TEXT,
  posted_raw TEXT,
  discovered_on TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'discovered' CHECK (stage IN ('discovered', 'pipeline', 'archived')),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'applied', 'interviewing', 'offer', 'passed', 'closed', 'rejected')),
  applied_on TEXT,
  notes TEXT,
  jd_text TEXT,
  fetched_text TEXT,
  fetched_at TEXT,
  fetch_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX postings_company_title ON postings(company_title_key);
CREATE INDEX postings_stage_status ON postings(stage, status);
CREATE INDEX postings_discovered_on ON postings(discovered_on);

-- Every fit score ever given, by v1 or v2, so they can be compared.
CREATE TABLE scores (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
  reason TEXT,
  analysis_json TEXT,
  source TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX scores_posting ON scores(posting_id);

-- Generated text: analyses, resume tweaks, cover letters (Doc reference when stored in Google Docs).
CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('analysis', 'resume_tweaks', 'cover_letter')),
  content TEXT,
  doc_id TEXT,
  doc_url TEXT,
  doc_name TEXT,
  flags_json TEXT,
  source TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_posting ON artifacts(posting_id, kind);

CREATE TABLE status_history (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by TEXT NOT NULL CHECK (changed_by IN ('import', 'agent', 'user')),
  changed_at TEXT NOT NULL
);
CREATE INDEX status_history_posting ON status_history(posting_id);
