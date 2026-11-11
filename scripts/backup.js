// Encrypted backup of data/job-agent.db, data/config/job-search.json, and data/attachments, uploaded to the
// "Job Agent Backups" folder in Google Drive, keeping 7 nightly, 3 weekly and 1 monthly copies.
// Prints the file name, size and counts only; never contents or the passphrase.
//   npm run backup                          back up now and upload
//   npm run backup -- --to E:\JobBackups     write the encrypted file to a folder (e.g. a USB drive), no upload
//   npm run backup -- --check-passphrase    check JOB_BACKUP_PASSPHRASE in .env, then stop
import { createJobTracer } from '../tools/trace.ts';
import { openJobStore } from '../db/index.ts';
import { ATTACHMENTS_DIR } from '../server/attachments.ts';
import { checkPassphrase } from '../tools/backup/crypto.ts';
import { createBackupDrive } from '../tools/backup/drive.ts';
import { localDate, runBackup } from '../tools/backup/run.ts';
import { getGoogleAuth } from '../tools/google/auth.ts';
import { dataPath } from '../tools/paths.ts';

/** @param {string} flag */
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const passphrase = process.env.JOB_BACKUP_PASSPHRASE;

async function main() {
  checkPassphrase(passphrase);
  if (process.argv.includes('--check-passphrase')) {
    console.log('The backup passphrase is set and long enough. Keep a copy in your password manager: without it the backups cannot be read.');
    return;
  }
  const toDir = arg('--to');
  const store = openJobStore();
  const run = await createJobTracer({ store, logger: { info() {}, warn() {}, error() {}, log() {} } }).startRun('backup', { to: toDir ? 'folder' : 'google-drive' });
  try {
    const r = await runBackup({
      backup: store.backup,
      passphrase,
      extras: [{ name: 'config/job-search.json', path: dataPath('config', 'job-search.json') }],
      folders: [{ name: 'attachments', dir: ATTACHMENTS_DIR }],
      drive: toDir ? undefined : createBackupDrive(getGoogleAuth()),
      toDir,
      date: localDate(),
    });
    // With toDir the result says where it was saved; without it, what the upload kept and deleted.
    const { savedTo, kept, deleted } = /** @type {{ savedTo?: string, kept?: number, deleted?: number }} */ (r);
    await run.finish('ok', { file: r.name, bytes: r.bytes, files: r.fileCount, attachments: r.attachments, ...(toDir ? { savedTo } : { kept, deleted }) });
    const kb = Math.round(r.bytes / 1024).toLocaleString();
    const what = `${kb} KB; the database, settings, and ${r.attachments} attachment${r.attachments === 1 ? '' : 's'}`;
    console.log(toDir
      ? `Encrypted backup written: ${savedTo} (${what})`
      : `Encrypted backup uploaded to Google Drive: ${r.name} (${what}). Kept ${kept}, deleted ${deleted}.`);
  } catch (err) {
    await run.finish('error', { error: /** @type {Error} */ (err).message });
    throw err;
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(`Backup failed: ${err.message}`);
  if (/invalid_grant/.test(err.message)) console.error('The saved Google sign-in is no longer valid. Run "npm run google:login".');
  process.exitCode = 1;
});
