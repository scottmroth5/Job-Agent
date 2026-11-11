import { asEngine } from '../db/engine/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openJobStore } from '../db/index.ts';
import { addValue } from '../agents/lookups.ts';
import { funnel, applications, NO_REPLY_DAYS } from '../server/funnel.ts';
import { fakeConfig, fakeServices } from './fixtures/fakes.js';

// Synthetic data only. "now" is fixed so ages and weeks are stable.
const now = new Date('2026-10-05T12:00:00Z');

function setup() {
  const store = openJobStore(':memory:');
  const { db } = store;
  const job = async (o = {}) =>
    Number(
      (await asEngine(db)
        .prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, source, track, discovered_on, stage, status, applied_on, created_at, updated_at)
          VALUES (1, @k, @company, @title, @k, @source, @track, @found, 'pipeline', @status, @applied, 'x', 'x')`)
        .run({ k: `k${Math.random()}`, company: 'Example Co', title: 'CTO', source: 'LinkedIn', track: 'fulltime', found: '2026-09-01', status: 'applied', applied: null, ...o })).id,
    );
  /** @param {number} id @param {string} to @param {string} at @param {string} [by] */
  const history = async (id, to, at, by = 'user') => await asEngine(db).prepare('INSERT INTO status_history (user_id, posting_id, from_status, to_status, changed_by, changed_at) VALUES (1, ?, NULL, ?, ?, ?)').run(id, to, by, `${at}T10:00:00Z`);
  /** @param {number} id @param {string} type @param {string} at @param {string} [review] */
  const email = async (id, type, at, review = 'auto') =>
    await asEngine(db).prepare(`INSERT INTO emails (user_id, id, gmail_message_id, thread_id, sender, sender_domain, sent_at, type, posting_id, review_status, created_at, updated_at)
      VALUES (1, ?, ?, 't', 'x@example.com', 'example.com', ?, ?, ?, ?, 'x', 'x')`).run(randomUUID(), randomUUID(), `${at}T09:00:00Z`, type, id, review);
  return { store, db, job, history, email };
}

test('milestones: a response email, an interview by status, a rejection, and a confirmation that is not a response', async () => {
  const { store, db, job, history, email } = setup();
  const byEmail = await job({ applied: '2026-09-01' });
  await email(byEmail, 'confirmation', '2026-09-01');
  await email(byEmail, 'follow_up', '2026-09-05');
  const byStatus = await job({ applied: '2026-09-10', status: 'interviewing' });
  await history(byStatus, 'interviewing', '2026-09-20');
  const rejected = await job({ applied: '2026-09-02', status: 'rejected' });
  await history(rejected, 'rejected', '2026-09-12');
  const ackOnly = await job({ applied: '2026-09-03' });
  await email(ackOnly, 'confirmation', '2026-09-03');
  await email(ackOnly, 'interview_request', '2026-09-04', 'needs_review');
  await job({ status: 'new' }); // not applied

  const apps = Object.fromEntries((await applications(db, { now })).map((a) => [a.id, a]));
  assert.equal(Object.keys(apps).length, 4);
  assert.deepEqual(apps[byEmail].responded, { reached: true, date: '2026-09-05' });
  assert.deepEqual([apps[byStatus].interview.date, apps[byStatus].responded.date], ['2026-09-20', '2026-09-20']);
  assert.deepEqual([apps[rejected].rejected.reached, apps[rejected].responded.reached, apps[rejected].closed], [true, true, true]);
  assert.equal(apps[ackOnly].responded.reached, false, 'a confirmation, or an email still in review, is not a response');
  assert.equal(apps[ackOnly].noReply, true);

  const f = await funnel(db, { now });
  assert.deepEqual(f.totals, { found: 5, scored7: 0, applied: 4, responded: 3, interview: 1, offer: 0, rejected: 1, noReply: 1 });
  assert.equal(f.rates.response, 0.75);
  assert.deepEqual([f.medians.daysToResponse, f.medians.responseSamples], [10, 3]); // 4, 10, 10 days
  store.close();
});

test('an added status in the In conversation group counts as an interview; imported history counts but is not timed', async () => {
  const { store, db, job, history } = setup();
  await addValue(db, 'status', { label: 'Phone screen', group: 'conversation' });
  const screen = await job({ applied: '2026-09-01', status: 'phone_screen' });
  await history(screen, 'phone_screen', '2026-09-08');
  const imported = await job({ applied: '2026-08-01', status: 'offer' });
  await history(imported, 'offer', '2026-09-30', 'import');
  const f = await funnel(db, { now });
  assert.deepEqual([f.totals.interview, f.totals.offer], [1, 1]);
  assert.deepEqual([f.medians.daysToInterview, f.medians.interviewSamples], [7, 1]);
  assert.equal((await applications(db, { now })).find((a) => a.id === imported)?.offer.date, null);
  store.close();
});

test('filters, by-source results, weekly counts, and the follow-up list', async () => {
  const { store, db, job, email } = setup();
  const old = await job({ applied: '2026-06-01', source: 'Himalayas' });
  const recent = await job({ applied: '2026-09-28', source: 'Himalayas' });
  await email(recent, 'interview_request', '2026-09-30');
  const stale = await job({ applied: '2026-09-15', source: 'LinkedIn' });
  await job({ applied: '2026-09-29', source: 'manual', track: 'fractional' });
  await job({ applied: '2026-09-29', source: 'Manual', track: 'fractional', status: 'new' });

  assert.equal((await funnel(db, { now })).totals.applied, 5);
  assert.equal((await funnel(db, { now, days: 30 })).totals.applied, 4);
  assert.equal((await funnel(db, { now, days: 30, track: 'fractional' })).totals.applied, 2);

  const f = await funnel(db, { now });
  assert.deepEqual(f.bySource.map((s) => [s.source, s.applied, s.responded]), [['Himalayas', 2, 1], ['manual', 2, 0], ['LinkedIn', 1, 0]]);
  assert.equal(f.weeks.length, 12);
  assert.equal(f.weeks.at(-1)?.weekStart, '2026-10-05');
  assert.equal(f.weeks.find((w) => w.weekStart === '2026-09-28')?.applied, 3);
  // From 7 days until the stale days (45 by default): the 126-day one is stale, the 6-day ones too new.
  assert.deepEqual(f.followUps.map((x) => [x.id, x.days]), [[stale, 20]]);
  assert.deepEqual([f.stale, f.staleDays], [1, 45]);
  assert.equal(old > 0, true);
  assert.deepEqual((await funnel(db, { now, staleDays: 200 })).followUps.map((x) => x.id), [old, stale], "a longer stale setting keeps it a follow-up");
  assert.equal((await applications(db, { now })).find((a) => a.id === stale)?.noReply, 20 >= NO_REPLY_DAYS);
  store.close();
});

test('GET /api/funnel applies the window and track, and rejects bad values', async () => {
  const { buildApp } = await import('../server/app.ts');
  const { store, job } = setup();
  await job({ applied: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) });
  await job({ applied: '2025-01-01' });
  const app = await buildApp({ store, config: fakeConfig({ search: { homeLocations: [] }, fractional: {} }), services: fakeServices({ createBrowser: async () => null }) });
  assert.equal((await app.inject('/api/funnel?days=all')).json().totals.applied, 2);
  assert.equal((await app.inject('/api/funnel?days=30')).json().totals.applied, 1);
  assert.equal((await app.inject('/api/funnel?days=30&track=fractional')).json().totals.applied, 0);
  assert.equal((await app.inject('/api/funnel?days=7')).statusCode, 400);
  await app.close();
  store.close();
});
