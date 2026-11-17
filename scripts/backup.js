// Encrypted backup of the database, data/config/job-search.json, and data/attachments, uploaded to the "Job Agent
// Backups" folder in Google Drive, keeping 7 nightly, 3 weekly and 1 monthly copies. Prints the file name, size and
// counts only; never contents or the passphrase.
//   npm run backup                          back up now and upload (SQLite: the app's own database file)
//   npm run backup -- --to E:\JobBackups     write the encrypted file to a folder (e.g. a USB drive), no upload
//   npm run backup -- --check-passphrase    check JOB_BACKUP_PASSPHRASE in .env, then stop
// On PostgreSQL the backup container runs backupJob with its pg_dump login (scripts/backup-service.js backup-now and the
// nightly schedule); this command stays for SQLite installs.
import { fileURLToPath } from 'node:url';
import { createJobTracer } from '../tools/trace.ts';
import { exitUnlessSqlite, openJobStore } from '../db/index.ts';
import { ATTACHMENTS_DIR } from '../server/attachments.ts';
import { checkPassphrase } from '../tools/backup/crypto.ts';
import { createBackupDrive } from '../tools/backup/drive.ts';
import { localDate, runBackup } from '../tools/backup/run.ts';
import { getGoogleAuth } from '../tools/google/auth.ts';
import { dataPath } from '../tools/paths.ts';
/**
 * @import { JobStore } from '../tools/types.ts'
 * @import { BackupDrive } from '../tools/backup/drive.ts'
 */

const quiet = { info() {}, warn() {}, error() {}, log() {} };

/**
 * One backup, recorded as a 'backup' run. pgUrl: a PostgreSQL database to pg_dump (the backup login; backup container
 * only); without it the store's SQLite file. toDir: write the file there instead of uploading.
 * @param {{ store: JobStore, passphrase: string | undefined, pgUrl?: string, drive?: BackupDrive, toDir?: string, date?: string }} o
 */
export async function backupJob({ store, passphrase, pgUrl, drive, toDir, date = localDate() }) {
  checkPassphrase(passphrase);
  const run = await createJobTracer({ store, logger: quiet }).startRun('backup', { to: toDir ? 'folder' : 'google-drive', engine: pgUrl ? 'postgres' : 'sqlite' });
  try {
    const r = await runBackup({
      ...(pgUrl ? { pgUrl } : { backup: store.backup }),
      passphrase,
      extras: [{ name: 'config/job-search.json', path: dataPath('config', 'job-search.json') }],
      folders: [{ name: 'attachments', dir: ATTACHMENTS_DIR }],
      drive: toDir ? undefined : (drive ?? createBackupDrive(getGoogleAuth())),
      toDir,
      date,
    });
    // With toDir the result says where it was saved; without it, what the upload kept and deleted.
    const { savedTo, kept, deleted } = /** @type {{ savedTo?: string, kept?: number, deleted?: number }} */ (r);
    await run.finish('ok', { file: r.name, bytes: r.bytes, files: r.fileCount, attachments: r.attachments, ...(toDir ? { savedTo } : { kept, deleted }) });
    return { ...r, savedTo, kept, deleted };
  } catch (err) {
    await run.finish('error', { error: /** @type {Error} */ (err).message });
    throw err;
  }
}

/** @param {{ name: string, bytes: number, attachments: number, savedTo?: string, kept?: number, deleted?: number }} r @param {boolean} toFolder */
export function describeBackup(r, toFolder) {
  const kb = Math.round(r.bytes / 1024).toLocaleString();
  const what = `${kb} KB; the database, settings, and ${r.attachments} attachment${r.attachments === 1 ? '' : 's'}`;
  return toFolder ? `Encrypted backup written: ${r.savedTo} (${what})` : `Encrypted backup uploaded to Google Drive: ${r.name} (${what}). Kept ${r.kept}, deleted ${r.deleted}.`;
}

async function main() {
  exitUnlessSqlite('npm run backup'); // on PostgreSQL, the backup container's backup-now
  /** @param {string} flag */
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const passphrase = process.env.JOB_BACKUP_PASSPHRASE;
  checkPassphrase(passphrase);
  if (process.argv.includes('--check-passphrase')) {
    console.log('The backup passphrase is set and long enough. Keep a copy in your password manager: without it the backups cannot be read.');
    return;
  }
  const toDir = arg('--to');
  const store = openJobStore();
  try {
    const r = await backupJob({ store, passphrase, toDir });
    console.log(describeBackup(r, Boolean(toDir)));
  } finally {
    store.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`Backup failed: ${err.message}`);
    if (/invalid_grant/.test(err.message)) console.error('The saved Google sign-in is no longer valid. Run "npm run google:login".');
    process.exitCode = 1;
  });
}
