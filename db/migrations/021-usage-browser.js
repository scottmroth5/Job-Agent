// Adds the browser dimension to usage_totals (020): browser and major version ("Chrome 130"), counted once per
// account a day like device and location (server/usage-totals.js). The CHECK on dimension changes, so the table is
// rebuilt the way SQLite documents it (new table, rows copied, old dropped, new renamed). Nothing references it,
// but the rule for rebuilds still applies: foreign keys off, checks before commit.

export const id = '021-usage-browser';
export const foreignKeys = false;

export function up(db) {
  db.exec(`
    CREATE TABLE usage_totals_new (
      day TEXT NOT NULL,
      dimension TEXT NOT NULL CHECK (dimension IN ('device', 'browser', 'location', 'source')),
      value TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, dimension, value)
    );
    INSERT INTO usage_totals_new (day, dimension, value, count) SELECT day, dimension, value, count FROM usage_totals;
    DROP TABLE usage_totals;
    ALTER TABLE usage_totals_new RENAME TO usage_totals;
  `);
}
