// v3 Phase 3, step 6: the lists, prompts, notes, and settings on the async engine. The races the conversion could
// open stay closed: marks claimed once, notes text adopted once, lists cached per connection and dropped on any edit,
// and a synchronous statement never lands in another request's open transaction. Synthetic rows in memory only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { asEngine } from '../db/engine/index.ts';
import { createSqliteEngine } from '../db/engine/sqlite.ts';
import { claimSetting, getSetting } from '../db/settings.ts';
import { addValue, lookups, updateValue } from '../agents/lookups.ts';
import { adoptNotesText, listNotes } from '../agents/notes.ts';
import { getPrompt, savePrompt } from '../agents/prompts.ts';
import { profileVersions, saveUserProfile } from '../agents/user-config.ts';
import { addResume, listResumes, MAX_RESUMES, updateResume } from '../agents/resumes.ts';

const store = () => openJobStore(':memory:', { fallbackUid: 1 });

/** A promise and the function that settles it, for holding a transaction open (strictTx off). */
function deferred() {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
}

/** @param {ReturnType<typeof store>} s @param {string | null} [notes] */
function addJob(s, notes = null) {
  return Number(
    s.db
      .prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, stage, status, notes, created_at, updated_at)
        VALUES (1, 'k1', 'Example Co', 'Head of Data', 'example co|head of data', '2026-11-01', 'pipeline', 'new', ?, 'x', 'x')`)
      .run(notes).lastInsertRowid,
  );
}

test('claimSetting: two callers at once, one claim', async () => {
  const s = store();
  const take = (/** @type {string | null} */ last) => last !== '2026-11-11';
  const results = await Promise.all([claimSetting(s.db, 'alert:x', '2026-11-11', take), claimSetting(s.engine, 'alert:x', '2026-11-11', take)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await getSetting(s.raw, 'alert:x'), '2026-11-11');
  s.close();
});

test('a synchronous statement from outside an open engine transaction fails; inside it, it runs as part of it', async () => {
  const s = store();
  const hold = deferred();
  const holder = createSqliteEngine(s.raw, { fallbackUid: 1, strictTx: false });
  const inside = holder.tx(async () => {
    s.db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('inside', '1', 'x')").run();
    await hold.promise;
    throw new Error('roll back');
  });
  await new Promise((r) => setImmediate(r));
  assert.throws(() => s.db.prepare('SELECT COUNT(*) FROM app_settings').pluck().get(), /another transaction was open/);
  assert.throws(() => s.db.exec('DELETE FROM app_settings'), /another transaction was open/);
  hold.resolve();
  await assert.rejects(inside, /roll back/);
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM app_settings WHERE key = 'inside'").pluck().get(), 0, 'it rolled back with the transaction');
  s.close();
});

test('lists: one cache per connection, dropped by an edit through any view', async () => {
  const s = store();
  const before = await lookups(s.db);
  assert.equal(await lookups(s.engine), before, 'every view of the connection shares the cache');
  const id = await addValue(s.engine, 'status', { label: 'On hold', group: 'waiting' });
  const after = await lookups(s.db);
  assert.notEqual(after, before);
  assert.equal(after.label('status', id), 'On hold');
  await updateValue(s.raw, 'status', id, { label: 'Paused for now' });
  assert.equal((await lookups(s.engine)).label('status', id), 'Paused for now');
  s.close();
});

test('lists: two adds of one label at once make one value', async () => {
  const s = store();
  const results = await Promise.allSettled([addValue(s.db, 'status', { label: 'Parked', group: 'waiting' }), addValue(s.db, 'status', { label: 'Parked', group: 'waiting' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await lookups(s.db)).values('status').filter((v) => v.label === 'Parked').length, 1);
  s.close();
});

test('notes text is adopted once, however many calls run at once', async () => {
  const s = store();
  const job = addJob(s, 'Spoke with the recruiter.');
  const counts = await Promise.all([adoptNotesText(s.db, { postingId: job }), adoptNotesText(s.engine, { postingId: job })]);
  assert.deepEqual(counts.sort(), [0, 1]);
  assert.equal((await listNotes(s.db, job)).length, 1);
  s.close();
});

test('prompts: a saved edit is the prompt in use, through any view', async () => {
  const s = store();
  const base = await getPrompt(s.db, 'cover-letter');
  const saved = await savePrompt(s.engine, 'cover-letter', { template: `${base.template}\nKeep it short.`, note: 'shorter' });
  assert.equal(saved.source, 'custom');
  assert.equal((await getPrompt(asEngine(s.db), 'cover-letter')).version, saved.version);
  s.close();
});

// Step 6b: the other agents' statements on the engine, and the transactions that keep their reads and writes together.

test('two knowledge doc saves at once keep both versions', async () => {
  const s = store();
  const text = (/** @type {string} */ word) => `${word} `.repeat(120).trim();
  await saveUserProfile(s.db, 1, text('first'));
  await Promise.all([saveUserProfile(s.db, 1, text('second')), saveUserProfile(s.db, 1, text('third'))]);
  const kept = (await profileVersions(s.db, 1)).map((v) => v.text.split(' ')[0]);
  assert.equal(kept.length, 3, 'three saves, three versions');
  assert.deepEqual([...kept].sort(), ['first', 'second', 'third']);
  s.close();
});

test('resumes: two made default at once leave one default; uploads at the limit stop at it', async () => {
  const s = store();
  const add = (/** @type {string} */ name) => addResume(s.db, { bytes: Buffer.from(`Resume ${name}\nTen years leading data and analytics teams, with planning and hiring.`), filename: `${name}.txt` });
  const a = await add('a');
  const b = await add('b');
  assert.ok(a && b);
  await Promise.all([updateResume(s.db, a.id, { isDefault: true }), updateResume(s.db, b.id, { isDefault: true })]);
  assert.equal((await listResumes(s.db)).filter((r) => r.isDefault).length, 1);
  for (let i = 2; i < MAX_RESUMES - 1; i++) await add(`r${i}`);
  const last = await Promise.allSettled([add('x'), add('y')]);
  assert.deepEqual(last.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await listResumes(s.db)).length, MAX_RESUMES);
  s.close();
});
