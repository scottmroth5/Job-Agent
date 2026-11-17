// The backup container on PostgreSQL (v3 Phase 5, ported from Health-Review): the only place pg_dump and pg_restore run,
// so the app image stays free of them. deploy/compose.yml runs it with the server's .env, backup.env and data folder.
//   node scripts/backup-service.js                        the schedule: SCHEDULE_BACKUP and SCHEDULE_RESTORE_TEST, with
//                                                         the same runs and failure emails as the app's scheduler
//   node scripts/backup-service.js backup-now             one encrypted backup to Drive (deploy.sh, before migrating)
//   node scripts/backup-service.js restore-test           one restore test into a scratch cluster
//   node scripts/backup-service.js pre-migrate            exit 0 none pending, 10 pending (checked dump kept), 1 failed
//   node scripts/backup-service.js restore-pre-migration  a failed deploy: the dump back over the live database
//   node scripts/backup-service.js reset-database --confirm <database>   before a load: refuses while anything else is
//                                                         connected, keeps a checked dump, then empties and migrates
//   node scripts/backup-service.js load-from-backup [--file <jabk>]      the cut-over: the newest SQLite backup in Drive
//                                                         (or a file) into the empty database, checked table by table
// Database addresses (never logged): DATABASE_URL (ja_app: runs, alerts, live counts), BACKUP_DATABASE_URL (ja_backup:
// pg_dump), MIGRATE_DATABASE_URL (ja_migrate: restore, reset and load only).
import { readFileSync, statSync } from 'node:fs';
import { openJobStore } from '../db/index.ts';
import { OWNER_ID } from '../db/users.ts';
import { runAsUser } from '../db/scope.ts';
import { createScheduler, schedulesFromEnv } from '../server/scheduler.ts';
import { createAlerts } from '../server/alerts.ts';
import { createBackupDrive } from '../tools/backup/drive.ts';
import { DRIVE_FOLDER } from '../tools/backup/run.ts';
import { newestBackup } from '../tools/backup/restore-check.ts';
import { loadFromBackup, newestDumpSince, preMigrate, resetDatabase, restorePreMigration } from '../tools/backup/pg-deploy.ts';
import { getGoogleAuth } from '../tools/google/auth.ts';
import { sendEmail } from '../tools/google/gmail.ts';
import { DATA_DIR, dataPath } from '../tools/paths.ts';
import { backupJob, describeBackup } from './backup.js';
import { restoreTestJob } from './backup-verify.js';
/** @import { JobStore } from '../tools/types.ts' */

const [command = 'serve', ...rest] = process.argv.slice(2);
/** @param {string} flag */
const arg = (flag) => {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
};
/** @param {string} name */
const need = (name) => {
  const v = process.env[name];
  if (!v) throw Object.assign(new Error(`${name} is not set`), { name: 'ConfigError' });
  return v;
};
const backupsDir = dataPath('backups');
const DEPLOY_MARKER = dataPath('.deploy-started');

/** The app's store as its own login (deploy mode: it never migrates). @template T @param {(store: JobStore) => Promise<T>} fn */
async function withAppStore(fn) {
  need('DATABASE_URL');
  const store = openJobStore();
  try {
    await store.ready;
    return await fn(store);
  } finally {
    store.close();
  }
}

/** @param {JobStore} store */
const backupOnce = (store) => runAsUser(OWNER_ID, () => backupJob({ store, passphrase: process.env.JOB_BACKUP_PASSPHRASE, pgUrl: need('BACKUP_DATABASE_URL') }));
/** @param {JobStore} store */
const restoreTestOnce = (store) => runAsUser(OWNER_ID, () => restoreTestJob({ store, passphrase: need('JOB_BACKUP_PASSPHRASE'), drive: createBackupDrive(getGoogleAuth()) }));

async function serve() {
  need('DATABASE_URL');
  const store = openJobStore();
  await store.ready;
  const alerts = createAlerts({
    db: store.db,
    send: (email) => sendEmail(getGoogleAuth(), email),
    to: () => process.env.EMAIL_ADDRESS || null,
    appUrl: () => process.env.PUBLIC_URL ?? '',
  });
  /** @type {Record<string, () => Promise<unknown>>} */
  const runners = {
    backup: async () => console.log(`[backup] ${describeBackup(await backupOnce(store), false)}`),
    'restore-test': async () => {
      const r = await restoreTestOnce(store);
      console.log(`[restore-test] ${r.ok ? 'ok' : 'failed'} ${r.file}: ${r.tables} tables, ${r.problems.length} problems`);
      if (!r.ok) throw new Error(`The restore test failed for ${r.file}: ${r.problems.join('; ')}`);
    },
  };
  /** @param {string} name */
  const lastRanAt = (name) => async () =>
    /** @type {string | null} */ ((await store.admin.prepare(`SELECT started_at FROM runs WHERE name = ? AND (user_id = ${OWNER_ID} OR user_id IS NULL) ORDER BY id DESC LIMIT 1`).pluck().get(name)) ?? null);
  const scheduler = createScheduler({
    jobs: schedulesFromEnv().filter((j) => runners[j.name]).map((j) => ({ ...j, run: /** @type {() => Promise<unknown>} */ (runners[j.name]), lastRanAt: lastRanAt(j.name) })),
    onResult: (name, ok, error) => alerts.jobResult(name, ok, error),
  });
  await scheduler.start();
  // The scheduler's timer does not hold the process open; this does, until a stop signal.
  const keepAlive = setInterval(() => {}, 1 << 30);
  const stop = () => {
    scheduler.stop();
    clearInterval(keepAlive);
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log('[backup-service] running');
}

async function main() {
  switch (command) {
    case 'serve':
      await serve();
      return 0;
    case 'backup-now':
      return withAppStore(async (store) => {
        console.log(`backup: ${describeBackup(await backupOnce(store), false)}`);
        return 0;
      });
    case 'restore-test':
      return withAppStore(async (store) => {
        const r = await restoreTestOnce(store);
        console.log(`restore-test: ${r.ok ? 'ok' : 'failed'} ${r.file}: ${r.tables} tables, ${r.problems.length} problems`);
        return r.ok ? 0 : 1;
      });
    case 'pre-migrate':
      return (await preMigrate({ backupUrl: need('BACKUP_DATABASE_URL'), dir: backupsDir })).code;
    case 'restore-pre-migration': {
      let since;
      try {
        since = statSync(DEPLOY_MARKER).mtime;
      } catch {
        throw new Error('No deploy marker (data/.deploy-started); nothing to restore');
      }
      const file = newestDumpSince(backupsDir, since);
      if (!file) throw new Error('No pre-migration dump since this deploy began; nothing to restore');
      await restorePreMigration({ migrateUrl: need('MIGRATE_DATABASE_URL'), file });
      return 0;
    }
    case 'reset-database':
      return resetDatabase({ backupUrl: need('BACKUP_DATABASE_URL'), migrateUrl: need('MIGRATE_DATABASE_URL'), dir: backupsDir, confirm: arg('--confirm') });
    case 'load-from-backup': {
      const passphrase = need('JOB_BACKUP_PASSPHRASE');
      let file;
      const from = arg('--file');
      if (from) file = readFileSync(from);
      else {
        const drive = createBackupDrive(getGoogleAuth());
        const newest = await newestBackup(drive, DRIVE_FOLDER);
        if (!newest) throw new Error(`No backups found in the "${DRIVE_FOLDER}" Drive folder`);
        console.log(`load-from-backup: ${newest.name}`);
        file = await drive.download(newest.id);
      }
      return loadFromBackup({ file, passphrase, migrateUrl: need('MIGRATE_DATABASE_URL'), dataDir: DATA_DIR });
    }
    default:
      throw new Error(`Unknown command "${command}"`);
  }
}

main().then(
  (code) => {
    if (command !== 'serve') process.exitCode = code;
  },
  (err) => {
    // Messages written for people; a PostgreSQL program's own output never reaches here (tools/backup/pg.ts). A database
    // error (it has a SQLSTATE code) is named by its code only, since its message can quote a value.
    const sqlState = typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code);
    console.error(`[backup-service] ${command} failed: ${err.name}: ${sqlState ? `code ${err.code}` : err.message}`);
    process.exitCode = 1;
  },
);
