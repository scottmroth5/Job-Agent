// The monthly backup restore test: downloads the newest encrypted backup from the "Job Agent Backups" Drive folder (or
// reads a file), decrypts it into the OS temp folder, checks the database's integrity, compares table row counts with the
// live database, and deletes the copy (tools/backup/restore-check.js). Records a 'restore-test' run. Prints the file name
// and counts only; never contents or the passphrase. A failure exits 1, so the scheduler emails the owner.
//   npm run backup:test                       test the newest backup in Google Drive
//   npm run backup:test -- --file <path>      test a backup file instead
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJobTracer } from '../tools/trace.js';
import { openJobStore } from '../db/index.js';
import { checkPassphrase } from '../tools/backup/crypto.js';
import { createBackupDrive } from '../tools/backup/drive.js';
import { DRIVE_FOLDER } from '../tools/backup/run.js';
import { newestBackup, restoreTest } from '../tools/backup/restore-check.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { exitWhenDone } from '../tools/exit.js';

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const quiet = { info() {}, warn() {}, error() {}, log() {} };

/**
 * Tests one backup against the live database. drive: a Drive client (tests pass a fake); fromFile: a backup file instead.
 * @returns the restore test's result plus the file's name
 */
export async function restoreTestJob({ store, passphrase, drive, fromFile }) {
  const run = createJobTracer({ store, logger: quiet }).startRun('restore-test', { from: fromFile ? 'file' : 'google-drive' });
  try {
    let name;
    let file;
    if (fromFile) {
      name = fromFile.split(/[\\/]/).pop();
      file = readFileSync(fromFile);
    } else {
      const newest = await newestBackup(drive, DRIVE_FOLDER);
      if (!newest) throw new Error(`No backups found in the "${DRIVE_FOLDER}" Drive folder.`);
      name = newest.name;
      file = await drive.download(newest.id);
    }
    const r = restoreTest({ file, passphrase, live: store.raw });
    run.finish(r.ok ? 'ok' : 'failed', { file: name, tables: r.tables, rowsBackup: r.rowsBackup, rowsLive: r.rowsLive, differences: r.differences.length, problems: r.problems });
    return { ...r, file: name };
  } catch (err) {
    run.finish('failed', { error: err.message });
    throw err;
  }
}

async function main() {
  const passphrase = process.env.JOB_BACKUP_PASSPHRASE;
  checkPassphrase(passphrase);
  const store = openJobStore();
  try {
    const fromFile = arg('--file');
    const r = await restoreTestJob({ store, passphrase, fromFile, drive: fromFile ? null : createBackupDrive(getGoogleAuth()) });
    const summary = `${r.file}: ${r.tables} tables, ${r.rowsBackup.toLocaleString()} rows (live ${r.rowsLive.toLocaleString()}), ${r.differences.length} tables differ in count`;
    if (!r.ok) throw new Error(`The restore test failed for ${summary}: ${r.problems.join('; ')}`);
    console.log(`Restore test passed: ${summary}.`);
  } finally {
    store.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(exitWhenDone);
}
