-- App-wide usage totals (server/usage-totals.js): a count per day for one dimension at a time (device, location, or
-- source). No user id, address, browser string, or referrer, and nothing that links one dimension to another, so it
-- holds no one's data: it is not a user table (db/user-tables.js), and account export and deletion leave it alone.
-- Backed up with the rest of the database.
CREATE TABLE usage_totals (
  day TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('device', 'location', 'source')),
  value TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dimension, value)
);
