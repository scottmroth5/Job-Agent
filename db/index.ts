import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openStore } from '@scottmroth5/agent-core';
import { repoPath, dataPath } from '../tools/paths.ts';
import * as duplicateStatus from './migrations/008-duplicate-status.ts';
import * as lookups from './migrations/009-lookups.ts';
import * as postingNotes from './migrations/012-posting-notes.ts';
import * as users from './migrations/013-users.ts';
import * as accounts from './migrations/014-accounts.ts';
import * as activity from './migrations/015-activity.ts';
import * as timeZoneColumn from './migrations/016-time-zone.ts';
import * as resumes from './migrations/017-resumes.ts';
import * as noResponse from './migrations/018-no-response.ts';
import * as dismissedEmail from './migrations/019-dismissed-email.ts';
import * as usageBrowser from './migrations/021-usage-browser.ts';
import * as statusRoles from './migrations/023-status-roles.ts';
import { createSqliteEngine } from './engine/sqlite.ts';
import { appliedIn, backupConnection, copyDatabase } from './engine/files.ts';
import type { Db } from './engine/types.ts';
import type { Migration } from '@scottmroth5/agent-core';
import { OWNER_ID } from './users.ts';

/** openJobStore's store: the async data layer (db/engine) over one connection. */
export interface JobStore {
  /** Scoped to the current user (runAsUser), else fallbackUid: every query on a user table names user_id = @uid. */
  db: Db;
  /** Unscoped, for the admin's cross-user reads (server/admin-queries.ts), backups, and account deletion only. */
  admin: Db;
  /** An online backup of the open database into a new file (tools/backup). */
  backup: (to: string) => Promise<void>;
  close: () => void;
}

/** Default database file. Gitignored, like everything under data/. */
export const DB_PATH = dataPath('job-agent.db');
/** How many pre-migration copies are kept in data/backups (newest first). */
export const KEEP_MIGRATION_COPIES = 5;
const APP = 'job-agent';

const MIGRATIONS_DIR = repoPath('db', 'migrations');

// Migrations that need code rather than plain SQL. Each exports id and up(db); foreignKeys = false marks a table rebuild
// (agent-core runs it with foreign keys off, then checks them before it commits).
const CODE_MIGRATIONS: Array<{ id: string; up: Extract<Migration['up'], (...args: never[]) => unknown>; foreignKeys?: boolean }> = [duplicateStatus, lookups, postingNotes, users, accounts, activity, timeZoneColumn, resumes, noResponse, dismissedEmail, usageBrowser, statusRoles];

/** Migrations: the .sql files in db/migrations plus CODE_MIGRATIONS, applied in id (file-name) order. */
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ id: f.replace(/\.sql$/, ''), up: readFileSync(join(dir, f), 'utf8') }));
  return [...sql, ...CODE_MIGRATIONS.map(({ id, up, foreignKeys }) => ({ id, up, ...(foreignKeys === false ? { foreignKeys } : {}) }))].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export { copyDatabase };

/** Keeps the newest KEEP_MIGRATION_COPIES pre-migration copies in a folder; other files are never touched. */
export function pruneMigrationCopies(dir: string, keep = KEEP_MIGRATION_COPIES) {
  const copies = readdirSync(dir).filter((n) => /^pre-migration-\d{8}T\d{6,9}Z\.db$/.test(n)).sort().reverse();
  for (const name of copies.slice(keep)) rmSync(join(dir, name), { force: true });
}

/**
 * Opens the Job-Agent database with agent-core's store (runs, run_calls) plus this app's tables, applying any new
 * migrations. When one of this app's migrations is about to change an existing file, a checked copy is taken first
 * (back up before every database change): data/backups/pre-migration-<UTC stamp>.db beside the database, the newest
 * KEEP_MIGRATION_COPIES kept. Use ':memory:' in tests.
 *
 * store.db is scoped to one user (db/scope.ts): queries on user tables run as the user of the current request or job
 * (runAsUser), else as fallbackUid. Command-line scripts and tests act as the owner; the server passes null, so a
 * user-table query outside a request or job throws. store.admin is unscoped, for server/admin-queries.ts, backups, and
 * account deletion only. Migrations run here, on the connection, before either exists.
 * snapshot false: no copy (a throwaway copy itself).
 */
export function openJobStore(
  path = DB_PATH,
  { snapshot = true, log = console, fallbackUid = OWNER_ID }: { snapshot?: boolean; log?: { info?: (msg: string) => void }; fallbackUid?: number | null } = {},
): JobStore {
  const migrations = loadMigrations();
  let copy: string | null = null;
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
  const raw = store.db;
  return {
    db: createSqliteEngine(raw, { fallbackUid }),
    admin: createSqliteEngine(raw, { fallbackUid: null }),
    backup: (to) => backupConnection(raw, to),
    close: () => store.close(),
  };
}

/**
 * Which migrations opening a database would apply, found by applying them to a throwaway copy (so a migration that would
 * fail on this data fails here, before the real file is touched). The copy lives in tempDir and is deleted.
 * @returns {{ pending: string[] }}  'app:id' entries; empty when the database is current
 */
export function pendingMigrations(path: string, tempDir: string): { pending: string[] } {
  if (!existsSync(path)) return { pending: [] };
  const to = join(tempDir, `ja-pending-${process.pid}-${Date.now()}.db`);
  try {
    const before = appliedIn(path);
    copyDatabase(path, to);
    openJobStore(to, { snapshot: false }).close();
    const after = appliedIn(to);
    return { pending: after.filter((id) => !before.includes(id)) };
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(to + suffix, { force: true });
  }
}
