// Restores an encrypted backup into NEW files; it never touches data/job-agent.db or data/attachments.
//   npm run backup:restore -- --file latest --out data/restore/job-agent.db        newest backup in Google Drive
//   npm run backup:restore -- --file E:\JobBackups\jobs-2026-10-06.jabk --out data/restore/job-agent.db
// The settings and attachments are written to a "restored" folder next to the database.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createBackupDrive } from '../tools/backup/drive.js';
import { DRIVE_FOLDER, isBackupName, restoreBackup } from '../tools/backup/run.js';
import { getGoogleAuth } from '../tools/google/auth.js';

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const which = arg('--file');
  const out = arg('--out');
  if (!which || !out) throw new Error('Give --file <path or latest> and --out <new database file>');
  let file;
  if (which === 'latest') {
    const drive = createBackupDrive(getGoogleAuth());
    const folder = await drive.ensureFolder(DRIVE_FOLDER);
    const newest = (await drive.list(folder)).filter((f) => isBackupName(f.name)).sort((a, b) => b.name.localeCompare(a.name))[0];
    if (!newest) throw new Error(`No backups found in the "${DRIVE_FOLDER}" folder`);
    console.log(`Downloading ${newest.name}...`);
    file = await drive.download(newest.id);
  } else {
    file = readFileSync(which);
  }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const r = restoreBackup({ file, passphrase: process.env.JOB_BACKUP_PASSPHRASE, outPath: resolve(out) });
  console.log(`Restored and checked: ${r.database}${r.restoredDir ? `, plus ${r.files} files in ${r.restoredDir}` : ''}`);
  console.log('To use it: stop the server, move data\\job-agent.db (and data\\attachments) aside, then put the restored');
  console.log('database at data\\job-agent.db, restored\\attachments at data\\attachments, and restored\\config\\job-search.json');
  console.log('at data\\config\\job-search.json if you need it. Then start the server again (npm run ui).');
}

main().catch((err) => {
  console.error(`Restore failed: ${err.message}`);
  process.exitCode = 1;
});
