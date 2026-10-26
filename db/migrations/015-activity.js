// Multi-user, phase 4: when each user was last seen (the admin's Users screen), and feedback users send the owner.
// feedback is a user table: each row is its sender's, and only server/admin-queries.js reads across users.

export const id = '015-activity';

export function up(db) {
  db.exec(`ALTER TABLE users ADD COLUMN last_seen_at TEXT;
    CREATE TABLE feedback (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      page TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
      created_at TEXT NOT NULL,
      done_at TEXT
    );
    CREATE INDEX feedback_user ON feedback(user_id, created_at);
    CREATE INDEX feedback_status ON feedback(status, created_at);`);
}
