// The monthly backup restore test (tools/backup/restore-check.ts, scripts/backup-verify.js): a real encrypted backup of
// a made-up database is restored into a scratch copy and compared with the live one. Fast key settings; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.ts';
import { runBackup } from '../tools/backup/run.ts';
import { restoreTest, EMPTY_TABLE_MIN_ROWS } from '../tools/backup/restore-check.ts';
import { restoreTestJob } from '../scripts/backup-verify.js';
/** @import { BackupDrive } from '../tools/backup/drive.ts' */
/** @import { JobStore } from '../tools/types.ts' */

const PASS = 'a made-up passphrase for these tests';
const KDF = { logN: 14, r: 8, p: 1 }; // the lowest the decrypter accepts (test speed only)

/** @param {string} dir @param {number} jobs */
async function liveStore(dir, jobs) {
  const store = openJobStore(join(dir, 'job-agent.db'), { log: {} });
  const insert = store.admin.prepare("INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at) VALUES (1, ?, 'Example Co', 'CTO', ?, '2026-10-01', 'x', 'x')");
  for (let i = 0; i < jobs; i += 1) await insert.run(`k${i}`, `k${i}`);
  return store;
}
/** @param {JobStore} store @param {string} dir */
async function backupOf(store, dir) {
  const out = join(dir, 'out');
  mkdirSync(out, { recursive: true });
  await runBackup({ backup: store.backup, passphrase: PASS, toDir: out, date: '2026-10-26', kdf: KDF });
  return readFileSync(join(out, readdirSync(out)[0]));
}

test('a good backup passes: it decrypts, its database is sound, and every table is there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restore-test-'));
  const store = await liveStore(dir, 12);
  try {
    const file = await backupOf(store, dir);
    await store.admin.prepare("INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at) VALUES (1, 'new', 'Example Co', 'CTO', 'new', '2026-10-26', 'x', 'x')").run();
    const r = await restoreTest({ file, passphrase: PASS, live: store.admin });
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.deepEqual(r.differences.find((d) => d.table === 'postings'), { table: 'postings', backup: 12, live: 13 }, 'a day of new rows is a difference, not a failure');
    assert.ok(r.tables > 15);
    await assert.rejects(() => restoreTest({ file, passphrase: 'not the right passphrase at all', live: store.admin }));
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('ja-restore-test-')).length, 0, 'the scratch copy is always deleted');

    // Through the job: recorded as a run, from a file.
    const job = await restoreTestJob({ store, passphrase: PASS, fromFile: join(dir, 'out', readdirSync(join(dir, 'out'))[0]) });
    assert.equal(job.ok, true);
    assert.equal(await store.admin.prepare("SELECT status FROM runs WHERE name = 'restore-test'").pluck().get(), 'ok');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a backup missing its data fails; the newest backup comes from Drive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restore-test-'));
  const empty = await liveStore(dir, 0);
  const full = await liveStore(mkdtempSync(join(dir, 'live-')), EMPTY_TABLE_MIN_ROWS + 2);
  try {
    const file = await backupOf(empty, dir);
    const r = await restoreTest({ file, passphrase: PASS, live: full.admin });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /table postings is empty in the backup but has 12 rows/);

    const files = [{ id: 'old', name: 'jobs-2026-10-20.jabk' }, { id: 'new', name: 'jobs-2026-10-26.jabk' }, { id: 'x', name: 'notes.txt' }];
    /** @type {string[]} */
    const asked = [];
    // Only the calls the restore test makes.
    const drive = /** @type {BackupDrive} */ (/** @type {unknown} */ ({ ensureFolder: async () => 'folder', list: async () => files, download: async (/** @type {string} */ id) => { asked.push(id); return file; } }));
    const job = await restoreTestJob({ store: full, passphrase: PASS, drive });
    assert.deepEqual([asked, job.file, job.ok], [['new'], 'jobs-2026-10-26.jabk', false]);
    assert.equal(await full.admin.prepare("SELECT status FROM runs WHERE name = 'restore-test'").pluck().get(), 'failed');
    await assert.rejects(restoreTestJob({ store: full, passphrase: PASS, drive: { ...drive, list: async () => [] } }), /No backups found/);
  } finally {
    empty.close();
    full.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
