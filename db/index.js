import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from '@scottmroth5/agent-core';
import { repoPath, dataPath } from '../tools/paths.js';
import * as duplicateStatus from './migrations/008-duplicate-status.js';
import * as lookups from './migrations/009-lookups.js';
import * as postingNotes from './migrations/012-posting-notes.js';
import * as users from './migrations/013-users.js';
import { scopeDb } from './scope.js';
import { OWNER_ID } from './users.js';

/** Default database file. Gitignored, like everything under data/. */
export const DB_PATH = dataPath('job-agent.db');
/** How many pre-migration copies are kept in data/backups (newest first). */
export const KEEP_MIGRATION_COPIES = 5;
const APP = 'job-agent';

const MIGRATIONS_DIR = repoPath('db', 'migrations');

// Migrations that need code rather than plain SQL. Each exports id and up(db); foreignKeys = false marks a table rebuild
// (agent-core runs it with foreign keys off, then checks them before it commits).
const CODE_MIGRATIONS = [duplicateStatus, lookups, postingNotes, users];

/** Migrations: the .sql files in db/migrations plus CODE_MIGRATIONS, applied in id (file-name) order. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ id: f.replace(/\.sql$/, ''), up: readFileSync(join(dir, f), 'utf8') }));
  return [...sql, ...CODE_MIGRATIONS.map(({ id, up, foreignKeys }) => ({ id, up, ...(foreignKeys === false ? { foreignKeys } : {}) }))].sort((a, b) => (a.id < b.id ? -1 : 1));
}

const appliedIds = (db) => db.prepare("SELECT app || ':' || id FROM schema_migrations ORDER BY app, id").pluck().all();

/** The schema_migrations entries a database file has (empty for a new or migration-less file). Read-only. */
function appliedIn(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get() ? appliedIds(db) : [];
  } finally {
    db.close();
  }
}

/**
 * A consistent single-file copy of a database (VACUUM INTO), checked with PRAGMA integrity_check. Throws when the copy
 * is not sound, after deleting it.
 */
export function copyDatabase(path, to) {
  mkdirSync(dirname(to), { recursive: true });
  const src = new Database(path, { readonly: true, fileMustExist: true });
  try {
    src.prepare('VACUUM INTO ?').run(to);
  } finally {
    src.close();
  }
  const copy = new Database(to, { readonly: true });
  let ok;
  try {
    ok = copy.pragma('integrity_check', { simple: true }) === 'ok';
  } finally {
    copy.close();
  }
  if (!ok) {
    rmSync(to, { force: true });
    throw new Error(`The copy of ${path} failed its integrity check; not migrating`);
  }
  return to;
}

/** Keeps the newest KEEP_MIGRATION_COPIES pre-migration copies in a folder; other files are never touched. */
export function pruneMigrationCopies(dir, keep = KEEP_MIGRATION_COPIES) {
  const copies = readdirSync(dir).filter((n) => /^pre-migration-\d{8}T\d{6,9}Z\.db$/.test(n)).sort().reverse();
  for (const name of copies.slice(keep)) rmSync(join(dir, name), { force: true });
}

/**
 * Opens the Job-Agent database with agent-core's store (runs, run_calls) plus this app's tables, applying any new
 * migrations. When one of this app's migrations is about to change an existing file, a checked copy is taken first
 * (back up before every database change): data/backups/pre-migration-<UTC stamp>.db beside the database, the newest
 * KEEP_MIGRATION_COPIES kept. Use ':memory:' in tests.
 *
 * store.db is scoped to one user (db/scope.js): queries on user tables run as the user of the current request or job
 * (runAsUser), else as fallbackUid. Command-line scripts and tests act as the owner; the server passes null, so a
 * user-table query outside a request or job throws. store.raw is the unscoped database, for migrations, backups, and
 * server/admin-queries.js only.
 * @param {string} [path]
 * @param {{ snapshot?: boolean, log?: { info?: Function }, fallbackUid?: number|null }} [options]
 *   snapshot false: no copy (a throwaway copy itself)
 */
export function openJobStore(path = DB_PATH, { snapshot = true, log = console, fallbackUid = OWNER_ID } = {}) {
  const migrations = loadMigrations();
  let copy = null;
  if (snapshot && path !== ':memory:' && existsSync(path)) {
    const before = appliedIn(path);
    // Only this app's migrations are known here (agent-core keeps its own list); deploy.sh's pending check, which
    // migrates a throwaway copy, also catches agent-core's.
    const pending = migrations.filter((m) => !before.includes(`${APP}:${m.id}`)).map((m) => m.id);
    if (pending.length) {
      const stamp = new Date().toISOString().replace(/[-:.]/g, ''); // 20261024T153012123Z: milliseconds keep names apart
      copy = copyDatabase(path, join(dirname(path), 'backups', `pre-migration-${stamp}.db`));
      log.info?.(`[migrate] applying ${pending.join(', ')}; the database before them is ${copy}`);
    }
  }
  const store = openStore(path, { app: APP, migrations });
  if (copy) pruneMigrationCopies(dirname(copy));
  return { ...store, raw: store.db, db: scopeDb(store.db, { fallbackUid }) };
}

/**
 * Which migrations opening a database would apply, found by applying them to a throwaway copy (so a migration that would
 * fail on this data fails here, before the real file is touched). The copy lives in tempDir and is deleted.
 * @returns {{ pending: string[] }}  'app:id' entries; empty when the database is current
 */
export function pendingMigrations(path, tempDir) {
  if (!existsSync(path)) return { pending: [] };
  const to = join(tempDir, `ja-pending-${process.pid}-${Date.now()}.db`);
  try {
    const before = appliedIn(path);
    copyDatabase(path, to);
    const store = openJobStore(to, { snapshot: false });
    const after = appliedIds(store.db);
    store.close();
    return { pending: after.filter((id) => !before.includes(id)) };
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(to + suffix, { force: true });
  }
}
