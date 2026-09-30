-- Discovery details on postings, and every place a posting was seen.
ALTER TABLE postings ADD COLUMN workplace TEXT CHECK (workplace IN ('remote', 'hybrid', 'onsite'));
ALTER TABLE postings ADD COLUMN location_check TEXT
  CHECK (location_check IN ('remote', 'home', 'unverified', 'unknown', 'remote_signal', 'conflict'));
ALTER TABLE postings ADD COLUMN fetch_method TEXT;
ALTER TABLE postings ADD COLUMN source_job_id TEXT;

CREATE TABLE posting_sightings (
  id INTEGER PRIMARY KEY,
  posting_id INTEGER NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  url TEXT,
  seen_on TEXT NOT NULL,
  UNIQUE (posting_id, source, url)
);
CREATE INDEX posting_sightings_posting ON posting_sightings(posting_id);
