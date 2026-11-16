// Long url keys (v3 Phase 4, PR 4b): PostgreSQL refuses unique index entries over about 2.7 KB, so a key over 500
// characters is cut to 400 and fingerprinted (tools/urls.ts capUrlKey), and migration 026 rekeys stored ones. The app's
// rule, the SQLite migration, and the PostgreSQL migration must give the same key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openJobStore } from '../db/index.ts';
import { up } from '../db/migrations/026-long-url-keys.ts';
import { capUrlKey, MAX_URL_KEY, normalizeUrl } from '../tools/urls.ts';
import { repoPath } from '../tools/paths.ts';
import { onPostgres, sqliteOnly } from './fixtures/engine.js';

const longUrl = (/** @type {string} */ tail) => `https://jobs.example.com/apply?${'q='.concat('x'.repeat(3000))}&id=${tail}&utm_source=feed`;
// Accented letters and an emoji: characters, not bytes or UTF-16 units, are what all three copies count.
const wide = `jobs.example.com/${'é'.repeat(300)}${'\u{1F600}'.repeat(300)}`;

test('a short key is unchanged; a long one is cut and fingerprinted, the same link always giving the same key', () => {
  assert.equal(normalizeUrl('https://www.example.com/jobs/1/?utm_source=x'), 'example.com/jobs/1');
  const a = /** @type {string} */ (normalizeUrl(longUrl('1')));
  assert.equal(a, normalizeUrl(longUrl('1')), 'deterministic');
  assert.notEqual(a, normalizeUrl(longUrl('2')), 'links that differ only past the cut stay apart');
  assert.ok(a.startsWith('jobs.example.com/apply?'), 'the key starts as the cleaned link does');
  assert.match(a, /#sha256=[0-9a-f]{64}$/);
  assert.equal(Array.from(a).length, 400 + '#sha256='.length + 64);
  assert.ok(!a.includes('utm_source'), 'tracking parameters are removed before the cap');
  assert.equal(capUrlKey('x'.repeat(MAX_URL_KEY)), 'x'.repeat(MAX_URL_KEY), 'exactly the limit is kept');
  const w = capUrlKey(wide);
  assert.equal(Array.from(w).slice(0, 400).join(''), Array.from(wide).slice(0, 400).join(''), 'cut by characters, never inside one');
  assert.ok(Buffer.byteLength(w, 'utf8') < 2000, 'well under the index limit in bytes');
});

test('a job with a very long link is stored and found again by its key', async () => {
  const store = openJobStore(':memory:');
  try {
    const key = normalizeUrl(longUrl('7'));
    await store.db.prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
      VALUES (@uid, ?, ?, 'Acme', 'CTO', 'acme cto', '2026-11-16', '2026-11-16T00:00:00Z', '2026-11-16T00:00:00Z')`).run(longUrl('7'), key);
    assert.equal(await store.db.prepare('SELECT COUNT(*) FROM postings WHERE url_key = ? AND user_id = @uid').pluck().get(normalizeUrl(longUrl('7'))), 1);
  } finally {
    store.close();
  }
});

/** @param {string} key @param {(db: import('../tools/types.ts').Db) => Promise<void>} migrate */
async function rekeyed(key, migrate) {
  const store = openJobStore(':memory:');
  try {
    await store.admin.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
      VALUES (1, ?, 'Acme', 'CTO', 'acme cto', '2026-11-16', 'x', 'x')`).run(key);
    await migrate(store.admin);
    return await store.admin.prepare('SELECT url_key FROM postings').pluck().get();
  } finally {
    store.close();
  }
}

test('the SQLite migration gives the same key as the app', { skip: sqliteOnly('runs 026 on a SQLite connection') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ja-urlkeys-'));
  try {
    const file = join(dir, 'job-agent.db');
    const store = openJobStore(file, { snapshot: false });
    store.close();
    const raw = new Database(file);
    try {
      const keys = ['example.com/short', `example.com/${'a'.repeat(600)}`, wide];
      const insert = raw.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
        VALUES (1, ?, 'Acme', ?, 'k', '2026-11-16', 'x', 'x')`);
      keys.forEach((k, i) => insert.run(k, `t${i}`));
      up(raw);
      const after = /** @type {string[]} */ (raw.prepare('SELECT url_key FROM postings ORDER BY title').pluck().all());
      assert.deepEqual(after, keys.map(capUrlKey));
      assert.equal(after[0], 'example.com/short');
    } finally {
      raw.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the PostgreSQL migration gives the same key as the app', { skip: onPostgres ? false : 'PostgreSQL only (npm run test:pg)' }, async () => {
  const sql = readFileSync(repoPath('db', 'postgres', '026-long-url-keys.sql'), 'utf8');
  const run = async (/** @type {import('../tools/types.ts').Db} */ db) => {
    await db.prepare(sql).run();
  };
  for (const key of ['example.com/short', `example.com/${'a'.repeat(600)}`, wide]) {
    assert.equal(await rekeyed(key, run), capUrlKey(key));
  }
});
