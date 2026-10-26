// The monthly backup restore test (tools/backup/restore-check.js, scripts/backup-verify.js): a real encrypted backup of
// a made-up database is restored into a scratch copy and compared with the live one. Fast key settings; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.js';
import { runBackup } from '../tools/backup/run.js';
import { restoreTest, EMPTY_TABLE_MIN_ROWS } from '../tools/backup/restore-check.js';
import { restoreTestJob } from '../scripts/backup-verify.js';

const PASS = 'a made-up passphrase for these tests';
const KDF = { logN: 14, r: 8, p: 1 }; // the lowest the decrypter accepts (test speed only)

function liveStore(dir, jobs) {
  const store = openJobStore(join(dir, 'job-agent.db'), { log: {} });
  const insert = store.raw.prepare("INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at) VALUES (1, ?, 'Example Co', 'CTO', ?, '2026-10-01', 'x', 'x')");
  for (let i = 0; i < jobs; i += 1) insert.run(`k${i}`, `k${i}`);
  return store;
}
async function backupOf(store, dir) {
  const out = join(dir, 'out');
  mkdirSync(out, { recursive: true });
  await runBackup({ db: store.db, passphrase: PASS, toDir: out, date: '2026-10-26', kdf: KDF });
  return readFileSync(join(out, readdirSync(out)[0]));
}

test('a good backup passes: it decrypts, its database is sound, and every table is there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restore-test-'));
  const store = liveStore(dir, 12);
  try {
    const file = await backupOf(store, dir);
    store.raw.prepare("INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at) VALUES (1, 'new', 'Example Co', 'CTO', 'new', '2026-10-26', 'x', 'x')").run();
    const r = restoreTest({ file, passphrase: PASS, live: store.raw });
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.deepEqual(r.differences.find((d) => d.table === 'postings'), { table: 'postings', backup: 12, live: 13 }, 'a day of new rows is a difference, not a failure');
    assert.ok(r.tables > 15);
    assert.throws(() => restoreTest({ file, passphrase: 'not the right passphrase at all', live: store.raw }));
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('ja-restore-test-')).length, 0, 'the scratch copy is always deleted');

    // Through the job: recorded as a run, from a file.
    const job = await restoreTestJob({ store, passphrase: PASS, fromFile: join(dir, 'out', readdirSync(join(dir, 'out'))[0]) });
    assert.equal(job.ok, true);
    assert.equal(store.raw.prepare("SELECT status FROM runs WHERE name = 'restore-test'").pluck().get(), 'ok');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a backup missing its data fails; the newest backup comes from Drive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restore-test-'));
  const empty = liveStore(dir, 0);
  const full = liveStore(mkdtempSync(join(dir, 'live-')), EMPTY_TABLE_MIN_ROWS + 2);
  try {
    const file = await backupOf(empty, dir);
    const r = restoreTest({ file, passphrase: PASS, live: full.raw });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /table postings is empty in the backup but has 12 rows/);

    const files = [{ id: 'old', name: 'jobs-2026-10-20.jabk' }, { id: 'new', name: 'jobs-2026-10-26.jabk' }, { id: 'x', name: 'notes.txt' }];
    const asked = [];
    const drive = { ensureFolder: async () => 'folder', list: async () => files, download: async (id) => { asked.push(id); return file; } };
    const job = await restoreTestJob({ store: full, passphrase: PASS, drive });
    assert.deepEqual([asked, job.file, job.ok], [['new'], 'jobs-2026-10-26.jabk', false]);
    assert.equal(full.raw.prepare("SELECT status FROM runs WHERE name = 'restore-test'").pluck().get(), 'failed');
    await assert.rejects(restoreTestJob({ store: full, passphrase: PASS, drive: { ...drive, list: async () => [] } }), /No backups found/);
  } finally {
    empty.close();
    full.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
