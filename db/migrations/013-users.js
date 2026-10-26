// Multi-user, phase 1: a users table (the owner is user 1, an admin) and user_id on every user table, with every
// existing row given to the owner. Keys that were unique across the whole database become unique per user (a job's
// URL, a Gmail message or thread, a contact's address), so each table is rebuilt the way SQLite documents it: a new
// table with user_id NOT NULL, the rows copied, the old table dropped, the new one renamed, its indexes and triggers
// made again. This needs foreign keys off (foreignKeys: false), or dropping postings would delete every score, letter,
// and note through ON DELETE CASCADE; agent-core turns them off for this migration only and refuses to commit unless
// foreign_key_check and integrity_check pass afterwards.
//
// The application_funnel view goes: a view cannot be limited to one user, and nothing in the app reads it.
// Settings that belong to a person (the inbox cursor, their Drive folders, the Home tile order) move from
// app_settings to the new user_settings table.

export const id = '013-users';
export const foreignKeys = false;

/** The tables this migration rebuilt (every user table at the time). Later ones are listed in db/user-tables.js. */
export const USER_TABLES = [
  'postings', 'scores', 'artifacts', 'attachments', 'contacts', 'decision_log', 'email_threads', 'emails',
  'meeting_preps', 'posting_notes', 'posting_sightings', 'prompt_versions', 'reminders', 'status_history', 'user_settings',
];

const OWNER = 1;

// Per-table edits to the CREATE TABLE text: [before, after] pairs (each must match once), plus a per-user key.
const EDITS = {
  postings: { replace: [['url_key TEXT UNIQUE,', 'url_key TEXT,']], add: 'UNIQUE (user_id, url_key)' },
  emails: { replace: [['gmail_message_id TEXT NOT NULL UNIQUE,', 'gmail_message_id TEXT NOT NULL,']], add: 'UNIQUE (user_id, gmail_message_id)' },
  contacts: { replace: [['email TEXT NOT NULL UNIQUE,', 'email TEXT NOT NULL,']], add: 'UNIQUE (user_id, email)' },
  email_threads: { replace: [['thread_id TEXT PRIMARY KEY,', 'thread_id TEXT NOT NULL,']], add: 'PRIMARY KEY (user_id, thread_id)' },
};

// Indexes that lead with user_id once every query filters by it.
const USER_FIRST_INDEXES = new Set([
  'postings_company_title', 'postings_stage_status', 'postings_discovered_on', 'postings_track', 'postings_company_domain',
  'emails_review', 'emails_thread', 'prompt_versions_name', 'prompt_versions_one_active',
]);

const PER_USER_SETTINGS = ["key = 'inbox.historyId'", "key LIKE 'drive.%'", "key LIKE 'layout:%'"];

function rebuild(db, table) {
  const create = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").pluck().get(table);
  if (!create) throw new Error(`013: table ${table} is missing`);
  const head = new RegExp(`^CREATE TABLE ${table} \\(`);
  if (!head.test(create)) throw new Error(`013: ${table} does not start the expected way; nothing was changed`);
  let sql = create.replace(head, `CREATE TABLE ${table}_new (\n  user_id INTEGER NOT NULL REFERENCES users(id),`);
  const edit = EDITS[table];
  for (const [before, after] of edit?.replace ?? []) {
    if (sql.split(before).length !== 2) throw new Error(`013: ${table} has no single "${before}"; nothing was changed`);
    sql = sql.replace(before, after);
  }
  if (edit?.add) {
    const end = sql.lastIndexOf(')');
    sql = `${sql.slice(0, end).trimEnd()},\n  ${edit.add}\n)`;
  }

  const attached = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL")
    .all(table);
  const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all().map((c) => `"${c}"`).join(', ');

  db.exec(sql);
  db.exec(`INSERT INTO ${table}_new (user_id, ${columns}) SELECT ${OWNER}, ${columns} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
  for (const a of attached) {
    db.exec(a.type === 'index' && USER_FIRST_INDEXES.has(a.name) ? a.sql.replace(/ON (\w+)\s*\(/, 'ON $1(user_id, ') : a.sql);
  }
}

export function up(db) {
  const now = new Date().toISOString();
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'paused')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.prepare("INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (?, NULL, NULL, 'admin', 'active', ?, ?)").run(OWNER, now, now);

  db.exec('DROP VIEW IF EXISTS application_funnel');
  for (const table of USER_TABLES.filter((t) => t !== 'user_settings')) rebuild(db, table);

  db.exec(`CREATE TABLE user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    value TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  )`);
  const moved = `(${PER_USER_SETTINGS.join(' OR ')})`;
  db.exec(`INSERT INTO user_settings (user_id, key, value, updated_at) SELECT ${OWNER}, key, value, updated_at FROM app_settings WHERE ${moved}`);
  db.exec(`DELETE FROM app_settings WHERE ${moved}`);
  for (const t of ['scores', 'artifacts', 'status_history', 'posting_notes', 'attachments', 'meeting_preps', 'contacts', 'reminders', 'decision_log']) {
    db.exec(`CREATE INDEX ${t}_user ON ${t}(user_id)`);
  }
}
