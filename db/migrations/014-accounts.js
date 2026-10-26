// Multi-user, phase 2: accounts. users gains what registration and AI access need: a 'rejected' status, the request
// (name, note, when the terms were accepted), the decision (when, by whom), the user's own Claude key (sealed by
// tools/secret-box.js, never plain), and how their AI is paid for (their own key, or the owner's key with a monthly
// cap). users is rebuilt (its status CHECK changes) with foreign keys off, like 013. runs (agent-core's table) gains a
// user_id so run history and Claude spend are per user; it stays nullable because agent-core writes the row first and
// tools/trace.js stamps the user right after.

export const id = '014-accounts';
export const foreignKeys = false;

export function up(db) {
  const columns = db.prepare("SELECT name FROM pragma_table_info('users')").pluck().all().join(', ');
  db.exec(`CREATE TABLE users_new (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'paused', 'rejected')),
    request_note TEXT,
    terms_accepted_at TEXT,
    decided_at TEXT,
    decided_by INTEGER,
    claude_key_enc TEXT,
    ai_source TEXT NOT NULL DEFAULT 'own' CHECK (ai_source IN ('own', 'owner')),
    ai_cap_usd REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`INSERT INTO users_new (${columns}) SELECT ${columns} FROM users`);
  db.exec('DROP TABLE users');
  db.exec('ALTER TABLE users_new RENAME TO users');
  // The owner pays with ANTHROPIC_API_KEY.
  db.exec("UPDATE users SET ai_source = 'owner' WHERE id = 1");

  db.exec('ALTER TABLE runs ADD COLUMN user_id INTEGER REFERENCES users(id)');
  db.exec('UPDATE runs SET user_id = 1');
  db.exec('CREATE INDEX runs_user ON runs(user_id, started_at)');
}
