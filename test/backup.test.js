// Encrypted backups. Synthetic data only; Google Drive is faked, nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { decrypt, encrypt, pack, unpack } from '../tools/backup/crypto.js';
import { createBackupDrive } from '../tools/backup/drive.js';
import { backupName, localDate, restoreBackup, retention, runBackup, DRIVE_FOLDER } from '../tools/backup/run.js';

const PASS = 'correct horse battery staple';
const FAST = { logN: 14, r: 8, p: 1 }; // test speed only; real backups use the default (2^17)

function fakeDrive() {
  const files = new Map();
  let n = 0;
  const calls = [];
  return {
    files,
    calls,
    async ensureFolder(name) { calls.push(['folder', name]); return 'folder-1'; },
    async upload(folder, name, data) { calls.push(['upload', name]); const id = `f${++n}`; files.set(id, { id, name, data, folder }); return { id, name, size: data.length }; },
    async list() { calls.push(['list']); return [...files.values()].map(({ id, name, data }) => ({ id, name, size: data.length })); },
    async remove(id) { calls.push(['remove', id]); files.delete(id); },
  };
}

function sampleDb() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('synthetic a'), ('synthetic b');");
  return db;
}

/** A data folder with settings and two attachments under job folders. */
function sampleData() {
  const dir = mkdtempSync(join(tmpdir(), 'ja-test-'));
  writeFileSync(join(dir, 'job-search.json'), '{"search":{"synthetic":true}}');
  mkdirSync(join(dir, 'attachments', '7'), { recursive: true });
  mkdirSync(join(dir, 'attachments', '12'), { recursive: true });
  writeFileSync(join(dir, 'attachments', '7', 'aaaa'), '%PDF-1.4 synthetic resume');
  writeFileSync(join(dir, 'attachments', '12', 'bbbb'), 'synthetic offer letter');
  return {
    dir,
    extras: [{ name: 'config/job-search.json', path: join(dir, 'job-search.json') }, { name: 'missing.json', path: join(dir, 'nope.json') }],
    folders: [{ name: 'attachments', dir: join(dir, 'attachments') }],
  };
}

test('crypto: round trip; fresh salt and nonce each time; wrong passphrase and any changed byte fail', () => {
  const plain = Buffer.from('synthetic payload '.repeat(50));
  const a = encrypt(plain, PASS, FAST);
  const b = encrypt(plain, PASS, FAST);
  assert.deepEqual(decrypt(a, PASS), plain);
  assert.notDeepEqual(a, b, 'two encryptions of the same data differ');
  assert.throws(() => decrypt(a, 'a different passphrase!!'), /wrong passphrase, or the file was changed/);
  for (const at of [6, 10, 30, a.length - 20, a.length - 1]) { // key settings, salt, nonce, ciphertext, tag
    const bad = Buffer.from(a);
    bad[at] ^= 1;
    assert.throws(() => decrypt(bad, PASS), at === 6 ? /invalid key settings|wrong passphrase/ : /wrong passphrase, or the file was changed/, `byte ${at}`);
  }
  assert.throws(() => decrypt(Buffer.from('not a backup at all, just text'), PASS), /Not a Job Agent backup/);
  assert.throws(() => encrypt(plain, 'short'), /at least 16 characters/);
  assert.throws(() => encrypt(plain, ''), /JOB_BACKUP_PASSPHRASE is not set/);
});

test('crypto: archives hold several files and detect damage', () => {
  const files = [{ name: 'job-agent.db', data: Buffer.from('db bytes') }, { name: 'attachments/7/aaaa', data: Buffer.from('pdf') }];
  assert.deepEqual(unpack(pack(files)).map((f) => [f.name, f.data.toString()]), [['job-agent.db', 'db bytes'], ['attachments/7/aaaa', 'pdf']]);
});

test('retention: 7 nightly, then the newest of 3 more weeks, then of 1 more month', () => {
  const days = Array.from({ length: 70 }, (_, i) => new Date(Date.UTC(2026, 9, 5) - i * 86400000).toISOString().slice(0, 10));
  const { keep, remove } = retention([...days.map(backupName), 'notes.txt']);
  assert.deepEqual(keep, [
    ...days.slice(0, 7).map(backupName),
    backupName('2026-09-26'), backupName('2026-09-19'), backupName('2026-09-12'),
    backupName('2026-08-31'),
  ]);
  assert.equal(keep.length + remove.length, 70, 'files that are not backups are never touched');
  assert.match(localDate(new Date(2026, 9, 6, 23, 30)), /^2026-10-06$/);
});

test('backup: uploads one encrypted, verified file with the database, settings, and attachments; prunes; no temp files left', async () => {
  const db = sampleDb();
  const drive = fakeDrive();
  const data = sampleData();
  for (let i = 1; i <= 9; i++) drive.files.set(`old${i}`, { id: `old${i}`, name: backupName(`2026-09-${String(20 + i).padStart(2, '0')}`), data: Buffer.from('x') });
  const tmpBefore = readdirSync(tmpdir()).filter((n) => n.startsWith('ja-backup-')).length;

  const r = await runBackup({ db, passphrase: PASS, ...data, drive, date: '2026-10-06', kdf: FAST });
  assert.deepEqual([r.name, r.fileCount, r.attachments, r.kept], ['jobs-2026-10-06.jabk', 4, 2, 7]);
  assert.equal(drive.calls[0][1], DRIVE_FOLDER);
  const uploaded = drive.files.get(r.driveFileId).data;
  assert.equal(uploaded.subarray(0, 5).toString(), 'JABK1');
  for (const plain of ['SQLite format 3', 'synthetic a', 'synthetic resume', 'synthetic offer']) assert.ok(!uploaded.includes(Buffer.from(plain)), `nothing readable: ${plain}`);
  assert.deepEqual(unpack(decrypt(uploaded, PASS)).map((f) => f.name), ['job-agent.db', 'config/job-search.json', 'attachments/12/bbbb', 'attachments/7/aaaa']);
  assert.ok(drive.calls.every(([kind]) => ['folder', 'list', 'upload', 'remove'].includes(kind)));
  assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('ja-backup-')).length, tmpBefore, 'temp snapshot deleted');

  const again = await runBackup({ db, passphrase: PASS, drive, date: '2026-10-06', kdf: FAST });
  assert.equal([...drive.files.values()].filter((f) => f.name === again.name).length, 1, 'a second run the same day replaces the first');
  db.close();
});

test('backup: no passphrase or a short one stops before anything is written; --to writes to a folder instead', async () => {
  const db = sampleDb();
  const drive = fakeDrive();
  await assert.rejects(runBackup({ db, passphrase: undefined, drive, date: '2026-10-06' }), /not set/);
  await assert.rejects(runBackup({ db, passphrase: 'too short', drive, date: '2026-10-06' }), /at least 16/);
  assert.equal(drive.calls.length, 0);
  const dir = mkdtempSync(join(tmpdir(), 'ja-usb-'));
  const r = await runBackup({ db, passphrase: PASS, toDir: dir, date: '2026-10-06', kdf: FAST });
  assert.equal(r.savedTo, join(dir, 'jobs-2026-10-06.jabk'));
  assert.equal(readFileSync(r.savedTo).subarray(0, 5).toString(), 'JABK1');
  db.close();
});

test('restore: the database, settings, and attachments come back identical; nothing is ever overwritten', async () => {
  const db = sampleDb();
  const data = sampleData();
  const r = await runBackup({ db, passphrase: PASS, ...data, toDir: data.dir, date: '2026-10-06', kdf: FAST });
  const outDir = mkdtempSync(join(tmpdir(), 'ja-restore-'));
  const out = join(outDir, 'job-agent.db');
  const res = restoreBackup({ file: readFileSync(r.savedTo), passphrase: PASS, outPath: out });
  const restored = new Database(out, { readonly: true });
  assert.deepEqual(restored.prepare('SELECT v FROM t ORDER BY id').all().map((x) => x.v), ['synthetic a', 'synthetic b']);
  restored.close();
  assert.equal(res.files, 3);
  assert.equal(readFileSync(join(outDir, 'restored', 'attachments', '7', 'aaaa'), 'utf8'), '%PDF-1.4 synthetic resume');
  assert.equal(readFileSync(join(outDir, 'restored', 'config', 'job-search.json'), 'utf8'), '{"search":{"synthetic":true}}');
  assert.throws(() => restoreBackup({ file: readFileSync(r.savedTo), passphrase: PASS, outPath: out }), /already exists/);
  assert.throws(() => restoreBackup({ file: readFileSync(r.savedTo), passphrase: PASS, outPath: join(outDir, 'second.db') }), /restored already exists/);
  assert.throws(() => restoreBackup({ file: readFileSync(r.savedTo), passphrase: 'wrong wrong wrong wrong', outPath: join(outDir, 'other.db') }), /wrong passphrase/);
  assert.ok(!existsSync(join(outDir, 'other.db')));
  db.close();
});

test('restore: refuses archive names that would land outside the restore folder', () => {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'ja-evil-')), 'x.db');
  const real = new Database(dbFile);
  real.exec('CREATE TABLE t (v TEXT)');
  real.close();
  for (const name of ['../escape.txt', 'attachments/../../escape', '/abs.txt', 'C:/abs.txt', 'a\\b.txt', 'a//b']) {
    const evil = encrypt(pack([{ name: 'job-agent.db', data: readFileSync(dbFile) }, { name, data: Buffer.from('x') }]), PASS, FAST);
    const out = join(mkdtempSync(join(tmpdir(), 'ja-evil-')), 'r.db');
    assert.throws(() => restoreBackup({ file: evil, passphrase: PASS, outPath: out }), /unsafe file name/, name);
    assert.ok(!existsSync(out), 'nothing written');
  }
});

test('drive client: resumable upload sends metadata, then the bytes to the session URL', async () => {
  const calls = [];
  const auth = {
    async request(opts) {
      calls.push(opts);
      if (opts.params?.uploadType === 'resumable') return { headers: new Headers({ location: 'https://upload.example/session-1' }), data: {} };
      return { headers: new Headers(), data: { id: 'file-1', name: 'jobs-2026-10-06.jabk', size: '3' } };
    },
  };
  const drive = createBackupDrive(auth);
  const res = await drive.upload('folder-1', 'jobs-2026-10-06.jabk', Buffer.from('abc'));
  assert.equal(res.id, 'file-1');
  assert.deepEqual(calls[0].data, { name: 'jobs-2026-10-06.jabk', parents: ['folder-1'], mimeType: 'application/octet-stream' });
  assert.equal(calls[0].headers['X-Upload-Content-Length'], '3');
  assert.equal(calls[1].url, 'https://upload.example/session-1');
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(calls[1].body, Buffer.from('abc'));

  const refused = createBackupDrive({ async request() { throw Object.assign(new Error('no'), { response: { status: 403 } }); } });
  await assert.rejects(refused.list('f'), /npm run google:login/);
});
