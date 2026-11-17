// The backup container's deploy and data steps on PostgreSQL (v3 Phase 5, ported from Health-Review), behind
// scripts/backup-service.js. Back up before every database change:
//   preMigrate           pg_dump of the live database (the backup login) to data/backups/pre-migration-<stamp>.dump,
//                        restored into a throwaway cluster, and this image's pending migrations run there first: 0 none
//                        pending (the dump is removed), 10 pending and they work on the copy (the dump is kept for
//                        restorePreMigration), 1 a migration failed on the copy (the live database is untouched).
//   restorePreMigration  a failed deploy: the newest dump since the deploy began goes back over the live database as the
//                        owner login (schema emptied first, then restored and granted again).
//   resetDatabase        before a load: the typed database name, no other connections, a checked dump kept, then the
//                        schema emptied and migrated afresh.
//   loadFromBackup       a Drive backup's SQLite database into the empty, migrated PostgreSQL database (the cut-over),
//                        through npm run db:to-postgres's copy and its per-table, per-user checks; its settings file and
//                        attachments go into the data folder where nothing is there yet.
// Plaintext only in the OS temp folder or data/backups (the server's encrypted disk, mode 600, newest kept); counts,
// names and exit codes in the output, never a value or an address.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import pg from 'pg';
import { loadMigrations } from '../../db/index.ts';
import { openPgStore, laterMigrations } from '../../db/postgres/store.ts';
import { grantStatements, JA_LOGINS, type Logins } from '../../db/postgres/roles.ts';
import { decrypt, unpack } from './crypto.ts';
import { DB_ENTRY, restoreBackup } from './run.ts';

type Log = (line: string) => void;

const stamp = (d = new Date()) => d.toISOString().replace(/[-:.]/g, '');
const DUMP_NAME = /^pre-migration-\d{8}T\d{9}Z\.dump$/;
/** Pre-migration dumps kept in data/backups (newest first), as with SQLite's pre-migration copies. */
export const KEEP_DUMPS = 5;

const sqliteIds = () => loadMigrations().map((m) => m.id);

/** This image's migrations that a database has not applied (app:id, as schema_migrations records them). */
async function pending(client: pg.Client): Promise<string[]> {
  const expected = ['postgres:000-baseline', ...laterMigrations().map((m) => `job-agent:${m.id}`)];
  const has = (await client.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t")).rows[0]?.t;
  const applied = new Set(has ? (await client.query<{ k: string }>("SELECT app || ':' || id AS k FROM schema_migrations")).rows.map((r) => r.k) : []);
  return expected.filter((k) => !applied.has(k));
}

/** Keeps the newest KEEP_DUMPS pre-migration dumps; other files are never touched. */
export function pruneDumps(dir: string, keep = KEEP_DUMPS) {
  if (!existsSync(dir)) return [];
  const old = readdirSync(dir).filter((n) => DUMP_NAME.test(n)).sort().reverse().slice(keep);
  for (const n of old) rmSync(join(dir, n), { force: true });
  return old;
}

export async function preMigrate({ backupUrl, dir, log = console.log }: { backupUrl: string; dir: string; log?: Log }) {
  const { dump, restoreInto, withScratchCluster } = await import('./pg.ts');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pre-migration-${stamp()}.dump`);
  await dump(backupUrl, file);
  chmodSync(file, 0o600);
  let result: { code: 0 | 10 | 1; pending: string[] };
  try {
    result = await withScratchCluster(async (scratch) => {
      await restoreInto(scratch, file);
      const client = new pg.Client({ connectionString: scratch });
      await client.connect();
      let todo: string[];
      try {
        todo = await pending(client);
      } finally {
        await client.end();
      }
      if (!todo.length) return { code: 0 as const, pending: todo };
      const store = openPgStore(scratch, { schema: 'public', sqliteIds: sqliteIds() });
      try {
        await store.ready;
        return { code: 10 as const, pending: todo };
      } catch (err) {
        log(`pre-migrate: a migration failed on the copy (${(err as Error).name}); the live database is untouched`);
        return { code: 1 as const, pending: todo };
      } finally {
        store.close();
      }
    });
  } catch (err) {
    rmSync(file, { force: true });
    throw err;
  }
  if (result.code !== 10) rmSync(file, { force: true });
  else pruneDumps(dir);
  log(`pre-migrate: ${result.pending.length ? `${result.pending.length} pending (${result.pending.join(', ')})` : 'none pending'}${result.code === 10 ? ', checked dump kept' : ''}`);
  return { ...result, file: result.code === 10 ? file : null };
}

/** The newest pre-migration dump in dir changed after since, or null. */
export function newestDumpSince(dir: string, since: Date) {
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).filter((n) => DUMP_NAME.test(n)).sort().reverse().find((n) => statSync(join(dir, n)).mtime > since);
  return name ? join(dir, name) : null;
}

/** Drops and makes again the public schema as the owner login, then grants (db/postgres/roles.ts), in one transaction. */
async function emptySchema(migrateUrl: string, logins: Logins) {
  const client = new pg.Client({ connectionString: migrateUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    for (const sql of grantStatements('public', logins)) await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/** Grants again after a restore: the tables the dump made are the owner's, and the app and backup logins need theirs. */
async function grantAgain(migrateUrl: string, logins: Logins) {
  const client = new pg.Client({ connectionString: migrateUrl });
  await client.connect();
  try {
    for (const sql of grantStatements('public', logins)) await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function restorePreMigration({ migrateUrl, file, logins = JA_LOGINS, log = console.log }: { migrateUrl: string; file: string; logins?: Logins; log?: Log }) {
  const { restoreLive } = await import('./pg.ts');
  // Objects a failed migration added are not in the dump, so the schema starts empty.
  await emptySchema(migrateUrl, logins);
  await restoreLive(migrateUrl, file);
  await grantAgain(migrateUrl, logins);
  log('restore-pre-migration: the database is back to its state before the deploy');
}

const databaseOf = (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));

/** Throws unless nothing else is connected (the app and the backup service stopped); waits up to waitMs first. */
async function refuseOtherConnections(url: string, waitMs: number) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    let others = 0;
    for (let waited = 0; ; waited += 100) {
      others = Number((await client.query<{ n: string }>('SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')).rows[0]?.n);
      if (!others || waited >= waitMs) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (others) throw new Error(`${others} other connection(s) to the database; stop the app and the backup service first`);
  } finally {
    await client.end();
  }
}

/**
 * Empties the database and migrates it afresh so a load can follow. Guarded three ways: the caller types the database's
 * name, nothing else may be connected, and a pg_dump checked in a scratch cluster is kept in dir first.
 */
export async function resetDatabase({ backupUrl, migrateUrl, dir, confirm, logins = JA_LOGINS, log = console.log, waitMs = 5000 }: {
  backupUrl: string; migrateUrl: string; dir: string; confirm?: string; logins?: Logins; log?: Log; waitMs?: number;
}) {
  const database = databaseOf(migrateUrl);
  if (!database || confirm !== database) throw new Error(`reset-database empties the whole database; type --confirm ${database || '<database>'} to go ahead`);
  await refuseOtherConnections(migrateUrl, waitMs);
  const { dump, restoreInto, withScratchCluster } = await import('./pg.ts');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pre-migration-${stamp()}.dump`);
  try {
    await dump(backupUrl, file);
    chmodSync(file, 0o600);
    await withScratchCluster((scratch) => restoreInto(scratch, file));
  } catch (err) {
    rmSync(file, { force: true });
    throw err;
  }
  pruneDumps(dir);
  await emptySchema(migrateUrl, logins);
  const store = openPgStore(migrateUrl, { schema: 'public', sqliteIds: sqliteIds() });
  try {
    await store.ready;
  } finally {
    store.close();
  }
  await grantAgain(migrateUrl, logins);
  log(`reset-database: checked dump kept (${basename(file)}); schema emptied; ${store.applied.length} migration(s) applied`);
  return 0;
}

/**
 * The cut-over's load: a SQLite backup's database into the empty, migrated PostgreSQL database through the copy and checks
 * of npm run db:to-postgres; its settings file and attachments are written under dataDir where none is there yet ('wx').
 * Returns the exit code: 0 every table matches, 2 some differ, 1 refused.
 */
export async function loadFromBackup({ file, passphrase, migrateUrl, dataDir, logins = JA_LOGINS, log = console.log }: {
  file: Buffer; passphrase: string; migrateUrl: string; dataDir: string; logins?: Logins; log?: Log;
}) {
  const files = unpack(decrypt(file, passphrase));
  if (!files.some((f) => f.name === DB_ENTRY)) throw new Error('load-from-backup takes a SQLite backup (job-agent.db); this one has none');
  const tmp = mkdtempSync(join(tmpdir(), 'ja-load-'));
  try {
    const { database, restoredDir } = restoreBackup({ file, passphrase, outPath: join(tmp, DB_ENTRY) });
    const { copySqliteToPostgres } = await import('../../scripts/migrate-sqlite-to-postgres.js');
    const { copied, checks } = await copySqliteToPostgres({ from: database, url: migrateUrl, schema: 'public' });
    await grantAgain(migrateUrl, logins);
    const bad = checks.filter((c) => !c.ok);
    log(`load-from-backup: ${Object.keys(copied ?? {}).length} tables copied; ${bad.length ? `${bad.length} DIFFER (${bad.map((c) => c.table).join(', ')})` : 'every table matches'}`);
    // The settings file and attachments, where the data folder has none (an existing file is never replaced).
    let written = 0;
    let kept = 0;
    for (const f of restoredDir ? files.filter((x) => x.name !== DB_ENTRY) : []) {
      const out = join(dataDir, ...f.name.split('/'));
      mkdirSync(dirname(out), { recursive: true });
      try {
        writeFileSync(out, f.data, { flag: 'wx', mode: 0o600 });
        written += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        kept += 1;
      }
    }
    log(`load-from-backup: ${written} file(s) written to the data folder, ${kept} already there and kept`);
    return bad.length ? 2 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

