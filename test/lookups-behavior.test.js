import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { addValue, updateValue, setRole, lookups, invalidateLookups } from '../agents/lookups.ts';
import { liveCopySql } from '../agents/identity.ts';
import { applications } from '../server/funnel.ts';
import { archivePostings } from '../agents/hunt/archive.ts';
import { selectPostings } from '../agents/discovery/score.ts';
import { planStatus } from '../agents/inbox/actions.ts';
import { listOpenApplications } from '../agents/inbox/match.ts';
import { listPostings, summary, updatePosting } from '../server/queries.ts';
import { buildScoreRequest, loadScorePrompts } from '../agents/discovery/score.ts';
import { fakeConfig } from './fixtures/fakes.js';

// Synthetic data only.
function setup() {
  const store = openJobStore(':memory:');
  const { db } = store;
  const add = (o = {}) =>
    Number(
      db
        .prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, stage, status, track, fetch_status, created_at, updated_at)
          VALUES (1, @k, 'Example Co', @title, @k, @on, @stage, @status, @track, 'ok', 'x', 'x')`)
        .run({ k: `k${Math.random()}`, title: 'CTO', on: '2026-01-01', stage: 'pipeline', status: 'new', track: 'fulltime', ...o }).lastInsertRowid,
    );
  return { store, db, add };
}

test('an added status behaves like the built-in ones in its group', () => {
  const { store, db, add } = setup();
  addValue(db, 'status', { label: 'Phone screen', group: 'conversation' });
  addValue(db, 'status', { label: 'Ghosted', group: 'closed' });
  addValue(db, 'status', { label: 'Referred', group: 'waiting' });
  const screen = add({ status: 'phone_screen' });
  const ghosted = add({ status: 'ghosted' });
  const referred = add({ status: 'referred' });

  assert.deepEqual(listPostings(db, { status: 'progress' }).map((r) => r.id).sort(), [screen, referred].sort());
  assert.deepEqual(listPostings(db, { status: 'active' }), []);
  const moved = archivePostings(db, { now: new Date('2026-10-05') }).archived.map((m) => [m.id, m.reason]);
  assert.deepEqual(moved.sort(), [[ghosted, 'status ghosted'], [referred, 'discovered 2026-01-01, over 30 days ago']].sort(), 'conversation is never auto-archived');
  assert.ok(!selectPostings(db, { ids: undefined, allUnscored: true }).some((p) => p.id === ghosted), 'closed statuses are not scored');
  assert.ok(listOpenApplications(db).some((a) => a.id === screen), 'open application for the inbox');

  // The inbox ranks by group: an interview request on a phone-screen job is not a step forward.
  const lk = lookups(db);
  assert.match(String(planStatus('phone_screen', 'interview_request', lk).review), /backward/);
  assert.deepEqual(planStatus('referred', 'interview_request', lk), { change: { from: 'referred', to: 'interviewing' } });
  assert.match(String(planStatus('ghosted', 'offer', lk).review), /reopen/);
  updatePosting(db, add({ status: 'new' }), { status: 'referred' });
  assert.ok(db.prepare("SELECT applied_on FROM postings WHERE status = 'referred' AND applied_on IS NOT NULL").get(), 'a waiting status sets the applied date');
  store.close();
});

test('an archived inbox target sends the email to review instead of setting it', () => {
  const { store, db } = setup();
  // Archived before 023 gave it a role (the migration keeps such a value as the role's).
  store.raw.prepare("UPDATE lookup_values SET archived_at = 'x' WHERE list = 'status' AND id = 'interviewing'").run();
  invalidateLookups(db);
  assert.match(String(planStatus('applied', 'interview_request', lookups(db)).review), /"Interviewing" status is archived/);
  store.close();
});

test('status roles: the inbox, duplicates, cleanup, and the funnel use the values the roles point at', () => {
  const { store, db, add } = setup();
  for (const [label, group, role] of [['Moved forward', 'waiting', 'applied'], ['Turned down', 'closed', 'rejected'], ['Same job', 'closed', 'duplicate']]) {
    setRole(db, 'status', role, addValue(db, 'status', { label, group }));
  }
  const lk = lookups(db);
  assert.deepEqual(planStatus('new', 'confirmation', lk), { change: { from: 'new', to: 'moved_forward' } });
  assert.deepEqual(planStatus('moved_forward', 'rejection', lk), { change: { from: 'moved_forward', to: 'turned_down' } });
  assert.match(String(planStatus('offer', 'rejection', lk).review), /after an offer/);

  const keep = add();
  const copy = add();
  updatePosting(db, copy, { duplicateOf: keep });
  assert.equal(db.prepare('SELECT status FROM postings WHERE id = ?').pluck().get(copy), 'same_job');
  const live = db.prepare(`SELECT id FROM postings q WHERE user_id = @uid AND ${liveCopySql(db)}`).pluck().all();
  assert.ok(live.includes(keep) && !live.includes(copy), 'a copy closed with the duplicate role is not a live copy');

  const turned = add({ status: 'turned_down' });
  const old = add({ status: 'rejected' });
  db.prepare("UPDATE postings SET applied_on = '2026-09-01' WHERE id IN (?, ?) AND user_id = @uid").run(turned, old);
  const apps = Object.fromEntries(applications(db, { now: new Date('2026-10-05') }).map((a) => [a.id, a]));
  assert.equal(apps[turned].rejected.reached, true, "the role's value counts as rejected");
  assert.equal(apps[old].rejected.reached, false, 'the value the role left does not');
  store.close();
});

test('stages: an added active stage counts as pipeline; promotion and archiving use the roles', () => {
  const { store, db, add } = setup();
  addValue(db, 'stage', { label: 'Shortlist', group: 'active' });
  addValue(db, 'stage', { label: 'Cold storage', group: 'archived' });
  setRole(db, 'stage', 'archive', 'cold_storage');
  const a = add({ stage: 'shortlist', status: 'passed' });
  add({ stage: 'pipeline', status: 'applied', on: '2026-10-01' });
  assert.equal(summary(db).pipeline, 2);
  archivePostings(db, { now: new Date('2026-10-05') });
  assert.equal(db.prepare('SELECT stage FROM postings WHERE id = ?').pluck().get(a), 'cold_storage');
  store.close();
});

test('an added track chooses its scoring prompt', () => {
  const { store, db } = setup();
  addValue(db, 'track', { label: 'Contract', settings: { scorePrompt: 'score-fractional', terms: true } });
  const prompts = loadScorePrompts(db);
  const config = fakeConfig({ candidate: { name: 'Pat Example' }, search: { homeLocations: ['Anytown, ST'] }, fractional: { targetAnnual: [1, 2] } });
  const posting = { company: 'Example Co', title: 'CTO', track: 'contract', scorePrompt: lookups(db).scorePrompt('contract'), location_check: 'remote', fetched_text: 'Text' };
  assert.equal(buildScoreRequest(posting, { config, knowledge: 'k', model: 'claude-sonnet-5-5', prompts }).label, 'score-fractional');
  assert.equal(buildScoreRequest({ ...posting, track: 'fulltime', scorePrompt: 'score' }, { config, knowledge: 'k', model: 'claude-sonnet-5-5', prompts }).label, 'score');
  store.close();
});
