// Multi-user, phase 6: each user's own time zone (an IANA name such as America/Chicago), for their calendar days.
// Null means the app's zone (TZ in .env), which the owner always uses.

export const id = '016-time-zone';

export function up(db) {
  db.exec('ALTER TABLE users ADD COLUMN time_zone TEXT');
}
