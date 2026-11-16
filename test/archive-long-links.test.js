// npm run archive -- --long-links (agents/hunt/archive.ts archiveLongLinks): jobs whose link was too long to keep as
// its key (tools/urls.ts capUrlKey) are archived like a skipped site's, with a note and history; archived jobs, jobs in
// progress, and other users' jobs are left alone. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { runAsUser } from '../db/scope.ts';
import { addUser } from '../db/users.ts';
import { lookups } from '../agents/lookups.ts';
import { archiveLongLinks } from '../agents/hunt/archive.ts';
import { normalizeUrl } from '../tools/urls.ts';

const longLink = (/** @type {string} */ n) => normalizeUrl(`https://jobs.example.com/apply?q=${'x'.repeat(3000)}&n=${n}`);

test('archives the open jobs with a shortened link key, and only those', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  try {
    const lk = await lookups(db);
    // Both roles are always set (lookups seed them).
    const [found, archive] = /** @type {[string, string]} */ ([lk.role('stage', 'default'), lk.role('stage', 'archive')]);
    const add = async (/** @type {number} */ uid, /** @type {string | null} */ key, /** @type {string} */ stage, /** @type {string} */ status) =>
      Number((await store.admin.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at)
        VALUES (?, ?, 'Example Co', 'CTO', ?, '2026-11-01', ?, ?, 'x', 'x') RETURNING id`).run(uid, key, `k${Math.random()}`, stage, status)).id);
    const open = await add(1, longLink('1'), found, 'new');
    const short = await add(1, 'example.com/jobs/1', found, 'new');
    const applied = await add(1, longLink('2'), found, 'applied');
    const done = await add(1, longLink('3'), archive, 'passed');
    const other = await addUser(store.admin, { email: 'second@example.com' });
    const theirs = await add(other, longLink('1'), found, 'new');

    const preview = await archiveLongLinks(db, { dryRun: true });
    assert.deepEqual([preview.archived.map((p) => p.id), preview.inProgress], [[open], 1]);
    assert.equal(await db.prepare('SELECT stage FROM postings WHERE id = ? AND user_id = @uid').pluck().get(open), found, 'a dry run moves nothing');

    const result = await archiveLongLinks(db, { now: new Date('2026-11-16T15:00:00Z') });
    assert.deepEqual(result.archived.map((p) => p.id), [open]);
    const row = /** @type {{ stage: string, status: string }} */ (await db.prepare('SELECT stage, status FROM postings WHERE id = ? AND user_id = @uid').get(open));
    assert.deepEqual(row, { stage: archive, status: lk.role('status', 'passed') });
    assert.match(String(await db.prepare('SELECT body FROM posting_notes WHERE posting_id = ? AND user_id = @uid').pluck().get(open)), /link too long to match/);
    assert.equal(await db.prepare("SELECT changed_by FROM status_history WHERE posting_id = ? AND user_id = @uid").pluck().get(open), 'agent');

    const stageOf = async (/** @type {number} */ id) => await store.admin.prepare('SELECT stage FROM postings WHERE id = ?').pluck().get(id);
    assert.equal(await stageOf(short), found, 'a short link is not touched');
    assert.equal(await stageOf(applied), found, 'a job in progress is not touched');
    assert.equal(await stageOf(done), archive);
    assert.equal(await stageOf(theirs), found, "another user's job is not touched");
    assert.deepEqual((await runAsUser(other, () => archiveLongLinks(db, { dryRun: true }))).archived.map((p) => p.id), [theirs]);
    assert.equal((await archiveLongLinks(db)).archived.length, 0, 'running it again finds nothing');
  } finally {
    store.close();
  }
});
