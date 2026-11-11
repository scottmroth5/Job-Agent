import { asEngine } from '../db/engine/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { lookups, addValue, updateValue, moveValue, setRole, usageCounts, idFromLabel, sqlList } from '../agents/lookups.ts';

test('the built-in lists reproduce the original behavior', async () => {
  const store = openJobStore(':memory:');
  const lk = await lookups(store.db);
  assert.deepEqual(lk.needsAction(), ['new', 'offer']);
  assert.deepEqual(lk.inProgress(), ['applied', 'interviewing', 'offer']);
  assert.deepEqual(lk.closed(), ['passed', 'closed', 'rejected', 'no_response', 'duplicate']);
  assert.deepEqual(lk.neverAutoArchived(), ['interviewing', 'offer']);
  assert.deepEqual([lk.rank('new'), lk.rank('applied'), lk.rank('interviewing'), lk.rank('offer'), lk.rank('rejected')], [0, 1, 2, 3, null]);
  assert.deepEqual([lk.role('status', 'default'), lk.role('stage', 'promote'), lk.role('stage', 'archive'), lk.role('track', 'default')], ['new', 'pipeline', 'archived', 'fulltime']);
  assert.deepEqual(lk.ids('stage', 'active'), ['pipeline']);
  assert.deepEqual([lk.scorePrompt('fractional'), lk.scorePrompt('fulltime'), lk.showsTerms('fractional')], ['score-fractional', 'score', true]);
  store.close();
});

test('IDs come from labels, never change, and are safe to inline in SQL', () => {
  assert.equal(idFromLabel('Phone screen'), 'phone_screen');
  assert.equal(idFromLabel('Phone screen', ['phone_screen']), 'phone_screen_2');
  assert.equal(idFromLabel('2nd round'), 'v_2nd_round');
  assert.equal(idFromLabel('!!!'), 'value');
  assert.equal(sqlList(['new', 'offer']), "('new', 'offer')");
  assert.equal(sqlList([]), "('')");
  assert.throws(() => sqlList(["x'); DROP TABLE postings; --"]), /Not a list value ID/);
});

test('adding, renaming, regrouping, and ordering values', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const id = await addValue(db, 'status', { label: 'Phone screen', group: 'conversation' });
  assert.equal(id, 'phone_screen');
  let lk = await lookups(db);
  assert.ok(lk.inProgress().includes('phone_screen') && lk.neverAutoArchived().includes('phone_screen'));
  assert.equal(lk.rank('phone_screen'), 2);
  await updateValue(db, 'status', 'phone_screen', { label: 'Recruiter screen' });
  assert.equal((await lookups(db)).label('status', 'phone_screen'), 'Recruiter screen');
  await assert.rejects(async () => await addValue(db, 'status', { label: 'applied', group: 'waiting' }), /already in the status list/);
  await assert.rejects(async () => await addValue(db, 'status', { label: 'Ghosted', group: 'nowhere' }), /Choose a group/);
  await assert.rejects(async () => await addValue(db, 'colors', { label: 'Red' }), /Unknown list/);

  const last = async () => (await lookups(db)).values('status').at(-1)?.id;
  assert.equal(await last(), 'phone_screen');
  await moveValue(db, 'status', 'phone_screen', -1);
  assert.equal((await lookups(db)).values('status').at(-2)?.id, 'phone_screen');

  const track = await addValue(db, 'track', { label: 'Contract', settings: { scorePrompt: 'score-fractional', terms: true } });
  lk = await lookups(db);
  assert.deepEqual([lk.scorePrompt(track), lk.showsTerms(track), lk.groupOf('track', track)], ['score-fractional', true, 'track']);
  await assert.rejects(async () => await addValue(db, 'track', { label: 'Odd', settings: { scorePrompt: 'cover-letter' } }), /scoring prompt/);
  store.close();
});

test('archiving: allowed for any value except one holding a role; archived values keep their behavior', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const screen = await addValue(db, 'status', { label: 'Phone screen', group: 'conversation' });
  await updateValue(db, 'status', screen, { archived: true });
  const lk = await lookups(db);
  assert.equal(lk.selectable('status', screen), false);
  assert.ok(lk.inProgress().includes(screen), 'jobs that already have it keep its behavior');
  assert.equal((await lookups(db)).values('status', { includeArchived: false }).some((v) => v.id === screen), false);
  await updateValue(db, 'status', screen, { archived: false });
  assert.equal((await lookups(db)).selectable('status', screen), true);
  // The statuses the app sets itself hold roles (023), so they move the role before they can be archived.
  await assert.rejects(async () => await updateValue(db, 'status', 'interviewing', { archived: true }), /interview request moves a job/);
  await assert.rejects(async () => await setRole(db, 'status', 'rejected', 'applied'), /must be in closed/);

  await assert.rejects(async () => await updateValue(db, 'stage', 'pipeline', { archived: true }), /where 7\+ jobs are promoted/);
  await assert.rejects(async () => await updateValue(db, 'status', 'new', { group: 'closed' }), /Move that role first/);
  const shortlist = await addValue(db, 'stage', { label: 'Shortlist', group: 'active' });
  await setRole(db, 'stage', 'promote', shortlist);
  await updateValue(db, 'stage', 'pipeline', { archived: true });
  assert.equal((await lookups(db)).role('stage', 'promote'), 'shortlist');
  await assert.rejects(async () => await setRole(db, 'stage', 'promote', 'pipeline'), /archived; restore it first/);
  await assert.rejects(async () => await setRole(db, 'stage', 'archive', 'shortlist'), /must be in archived/);
  store.close();
});

test('usage counts per value', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  await asEngine(db).prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
    VALUES (1, 'a', 'Example Co', 'CTO', 'k', '2026-10-01', 'x', 'x'), (1, 'b', 'Example Co', 'VP', 'k2', '2026-10-01', 'x', 'x')`).run();
  assert.deepEqual(await usageCounts(db, 'status'), { new: 2 });
  store.close();
});
