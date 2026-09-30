-- How many times full text has been requested for a posting, so failed fetches are retried a limited number of times.
ALTER TABLE postings ADD COLUMN fetch_attempts INTEGER NOT NULL DEFAULT 0;
UPDATE postings SET fetch_attempts = 1 WHERE fetch_status IS NOT NULL;
