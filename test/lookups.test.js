import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { lookups, addValue, updateValue, moveValue, setRole, usageCounts, idFromLabel, sqlList } from '../agents/lookups.js';

test('the built-in lists reproduce the original behavior', () => {
  const store = openJobStore(':memory:');
  const lk = lookups(store.db);
  assert.deepEqual(lk.needsAction(), ['new', 'offer']);
  assert.deepEqual(lk.inProgress(), ['applied', 'interviewing', 'offer']);
  assert.deepEqual(lk.closed(), ['passed', 'closed', 'rejected', 'duplicate']);
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

test('adding, renaming, regrouping, and ordering values', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const id = addValue(db, 'status', { label: 'Phone screen', group: 'conversation' });
  assert.equal(id, 'phone_screen');
  let lk = lookups(db);
  assert.ok(lk.inProgress().includes('phone_screen') && lk.neverAutoArchived().includes('phone_screen'));
  assert.equal(lk.rank('phone_screen'), 2);
  updateValue(db, 'status', 'phone_screen', { label: 'Recruiter screen' });
  assert.equal(lookups(db).label('status', 'phone_screen'), 'Recruiter screen');
  assert.throws(() => addValue(db, 'status', { label: 'applied', group: 'waiting' }), /already in the status list/);
  assert.throws(() => addValue(db, 'status', { label: 'Ghosted', group: 'nowhere' }), /Choose a group/);
  assert.throws(() => addValue(db, 'colors', { label: 'Red' }), /Unknown list/);

  const last = () => lookups(db).values('status').at(-1).id;
  assert.equal(last(), 'phone_screen');
  moveValue(db, 'status', 'phone_screen', -1);
  assert.equal(lookups(db).values('status').at(-2).id, 'phone_screen');

  const track = addValue(db, 'track', { label: 'Contract', settings: { scorePrompt: 'score-fractional', terms: true } });
  lk = lookups(db);
  assert.deepEqual([lk.scorePrompt(track), lk.showsTerms(track), lk.groupOf('track', track)], ['score-fractional', true, 'track']);
  assert.throws(() => addValue(db, 'track', { label: 'Odd', settings: { scorePrompt: 'cover-letter' } }), /scoring prompt/);
  store.close();
});

test('archiving: allowed for any value except one holding a role; archived values keep their behavior', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  updateValue(db, 'status', 'interviewing', { archived: true });
  const lk = lookups(db);
  assert.equal(lk.selectable('status', 'interviewing'), false);
  assert.ok(lk.inProgress().includes('interviewing'), 'jobs that already have it keep its behavior');
  assert.equal(lookups(db).values('status', { includeArchived: false }).some((v) => v.id === 'interviewing'), false);
  updateValue(db, 'status', 'interviewing', { archived: false });
  assert.equal(lookups(db).selectable('status', 'interviewing'), true);

  assert.throws(() => updateValue(db, 'stage', 'pipeline', { archived: true }), /where 7\+ jobs are promoted/);
  assert.throws(() => updateValue(db, 'status', 'new', { group: 'closed' }), /Move that role first/);
  const shortlist = addValue(db, 'stage', { label: 'Shortlist', group: 'active' });
  setRole(db, 'stage', 'promote', shortlist);
  updateValue(db, 'stage', 'pipeline', { archived: true });
  assert.equal(lookups(db).role('stage', 'promote'), 'shortlist');
  assert.throws(() => setRole(db, 'stage', 'promote', 'pipeline'), /archived; restore it first/);
  assert.throws(() => setRole(db, 'stage', 'archive', 'shortlist'), /must be in archived/);
  store.close();
});

test('usage counts per value', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  db.prepare(`INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
    VALUES ('a', 'Example Co', 'CTO', 'k', '2026-10-01', 'x', 'x'), ('b', 'Example Co', 'VP', 'k2', '2026-10-01', 'x', 'x')`).run();
  assert.deepEqual(usageCounts(db, 'status'), { new: 2 });
  store.close();
});
