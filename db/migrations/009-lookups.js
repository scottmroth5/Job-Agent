// Configurable lists for job status, stage, and track (agents/lookups.js). Jobs keep storing each value's
// immutable text ID; labels, order, groups, and archiving live in lookup_values. The fixed CHECK lists on
// postings are removed in place (writable_schema, as in 008: SQLite documents removing CHECK constraints
// as safe, and no table rebuild means nothing can cascade) and replaced by triggers that accept any ID in
// lookup_values. Portable types; in PostgreSQL the triggers become foreign keys. Any failure rolls back.

export const id = '009-lookups';

// [list, id, label, group, settings] in display order. Groups decide behavior (see agents/lookups.js).
const BUILT_INS = [
  ['status', 'new', 'New', 'evaluate'],
  ['status', 'applied', 'Applied', 'waiting'],
  ['status', 'interviewing', 'Interviewing', 'conversation'],
  ['status', 'offer', 'Offer', 'decision'],
  ['status', 'passed', 'Passed', 'closed'],
  ['status', 'closed', 'Closed', 'closed'],
  ['status', 'rejected', 'Rejected', 'closed'],
  ['status', 'duplicate', 'Duplicate', 'closed'],
  ['stage', 'discovered', 'Discovered', 'found'],
  ['stage', 'pipeline', 'Pipeline', 'active'],
  ['stage', 'archived', 'Archived', 'archived'],
  ['track', 'fulltime', 'Full-time', 'track', { scorePrompt: 'score', terms: false }],
  ['track', 'fractional', 'Fractional', 'track', { scorePrompt: 'score-fractional', terms: true }],
];

const ROLES = [
  ['status', 'default', 'new'],
  ['stage', 'default', 'discovered'],
  ['stage', 'promote', 'pipeline'],
  ['stage', 'archive', 'archived'],
  ['track', 'default', 'fulltime'],
];

const FIXED_LISTS = /\s*CHECK \((stage|status|track) IN \([^)]*\)\)/g;

const GUARD = `
  SELECT RAISE(ABORT, 'status is not in the status list') WHERE NOT EXISTS (SELECT 1 FROM lookup_values WHERE list = 'status' AND id = NEW.status);
  SELECT RAISE(ABORT, 'stage is not in the stage list') WHERE NOT EXISTS (SELECT 1 FROM lookup_values WHERE list = 'stage' AND id = NEW.stage);
  SELECT RAISE(ABORT, 'track is not in the track list') WHERE NOT EXISTS (SELECT 1 FROM lookup_values WHERE list = 'track' AND id = NEW.track);`;

export function up(db) {
  db.exec(`
    CREATE TABLE lookup_values (
      list TEXT NOT NULL CHECK (list IN ('status', 'stage', 'track')),
      id TEXT NOT NULL,
      label TEXT NOT NULL,
      group_key TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      settings_json TEXT,
      origin TEXT NOT NULL CHECK (origin IN ('built_in', 'custom')),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (list, id)
    );
    CREATE TABLE lookup_roles (
      list TEXT NOT NULL,
      role TEXT NOT NULL,
      value_id TEXT NOT NULL,
      PRIMARY KEY (list, role),
      FOREIGN KEY (list, value_id) REFERENCES lookup_values (list, id)
    );`);
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO lookup_values (list, id, label, group_key, sort_order, settings_json, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'built_in', ?, ?)`);
  const order = {};
  for (const [list, vid, label, group, settings] of BUILT_INS) {
    order[list] = (order[list] ?? 0) + 10;
    insert.run(list, vid, label, group, order[list], settings ? JSON.stringify(settings) : null, now, now);
  }
  const role = db.prepare('INSERT INTO lookup_roles (list, role, value_id) VALUES (?, ?, ?)');
  for (const r of ROLES) role.run(...r);

  // Any value a job already uses must exist in the lists before the fixed lists go away.
  for (const list of ['status', 'stage', 'track']) {
    const missing = db
      .prepare(`SELECT DISTINCT ${list} FROM postings WHERE ${list} NOT IN (SELECT id FROM lookup_values WHERE list = ?)`)
      .pluck()
      .all(list);
    if (missing.length) throw new Error(`009: jobs use ${list} values not in the list: ${missing.join(', ')}; nothing was changed.`);
  }

  const createSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'postings'").pluck().get();
  const removed = createSql.match(FIXED_LISTS) ?? [];
  if (removed.length !== 3) throw new Error(`009: expected the status, stage, and track CHECK lists, found ${removed.length}; nothing was changed.`);
  const version = db.pragma('schema_version', { simple: true });
  db.unsafeMode(true);
  try {
    db.pragma('writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'postings'").run(createSql.replace(FIXED_LISTS, ''));
    db.pragma(`schema_version = ${version + 1}`);
    db.pragma('writable_schema = OFF');
  } finally {
    db.unsafeMode(false);
  }
  const check = db.pragma('integrity_check', { simple: true });
  if (check !== 'ok') throw new Error(`009: integrity check failed after the schema edit (${check}); rolled back.`);

  db.exec(`
    CREATE TRIGGER postings_lookups_insert BEFORE INSERT ON postings BEGIN ${GUARD}
    END;
    CREATE TRIGGER postings_lookups_update BEFORE UPDATE OF status, stage, track ON postings BEGIN ${GUARD}
    END;
    CREATE TRIGGER lookup_values_no_delete BEFORE DELETE ON lookup_values BEGIN
      SELECT RAISE(ABORT, 'list values are archived, never deleted');
    END;
    CREATE TRIGGER lookup_values_id_fixed BEFORE UPDATE OF list, id ON lookup_values BEGIN
      SELECT RAISE(ABORT, 'a list value ID never changes; edit its label instead');
    END;`);
}
