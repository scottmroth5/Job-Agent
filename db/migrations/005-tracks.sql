-- Full-time vs fractional track, with the rate and hours fields fractional roles are judged by.
ALTER TABLE postings ADD COLUMN track TEXT NOT NULL DEFAULT 'fulltime' CHECK (track IN ('fulltime', 'fractional'));
ALTER TABLE postings ADD COLUMN rate_text TEXT;
ALTER TABLE postings ADD COLUMN rate_min REAL;
ALTER TABLE postings ADD COLUMN rate_max REAL;
ALTER TABLE postings ADD COLUMN rate_unit TEXT CHECK (rate_unit IN ('hour', 'month', 'year', 'project'));
ALTER TABLE postings ADD COLUMN hours_min REAL;
ALTER TABLE postings ADD COLUMN hours_max REAL;
ALTER TABLE postings ADD COLUMN extra_json TEXT;
CREATE INDEX postings_track ON postings(track, stage);
