import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openJobStore } from '../db/index.js';
import { addValue } from '../agents/lookups.js';
import { funnel, applications, NO_REPLY_DAYS } from '../server/funnel.js';

// Synthetic data only. "now" is fixed so ages and weeks are stable.
const now = new Date('2026-10-05T12:00:00Z');

function setup() {
  const store = openJobStore(':memory:');
  const { db } = store;
  const job = (o = {}) =>
    Number(
      db
        .prepare(`INSERT INTO postings (url_key, company, title, company_title_key, source, track, discovered_on, stage, status, applied_on, created_at, updated_at)
          VALUES (@k, @company, @title, @k, @source, @track, @found, 'pipeline', @status, @applied, 'x', 'x')`)
        .run({ k: `k${Math.random()}`, company: 'Example Co', title: 'CTO', source: 'LinkedIn', track: 'fulltime', found: '2026-09-01', status: 'applied', applied: null, ...o }).lastInsertRowid,
    );
  const history = (id, to, at, by = 'user') => db.prepare('INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, NULL, ?, ?, ?)').run(id, to, by, `${at}T10:00:00Z`);
  const email = (id, type, at, review = 'auto') =>
    db.prepare(`INSERT INTO emails (id, gmail_message_id, thread_id, sender, sender_domain, sent_at, type, posting_id, review_status, created_at, updated_at)
      VALUES (?, ?, 't', 'x@example.com', 'example.com', ?, ?, ?, ?, 'x', 'x')`).run(randomUUID(), randomUUID(), `${at}T09:00:00Z`, type, id, review);
  return { store, db, job, history, email };
}

test('milestones: a response email, an interview by status, a rejection, and a confirmation that is not a response', () => {
  const { store, db, job, history, email } = setup();
  const byEmail = job({ applied: '2026-09-01' });
  email(byEmail, 'confirmation', '2026-09-01');
  email(byEmail, 'follow_up', '2026-09-05');
  const byStatus = job({ applied: '2026-09-10', status: 'interviewing' });
  history(byStatus, 'interviewing', '2026-09-20');
  const rejected = job({ applied: '2026-09-02', status: 'rejected' });
  history(rejected, 'rejected', '2026-09-12');
  const ackOnly = job({ applied: '2026-09-03' });
  email(ackOnly, 'confirmation', '2026-09-03');
  email(ackOnly, 'interview_request', '2026-09-04', 'needs_review');
  job({ status: 'new' }); // not applied

  const apps = Object.fromEntries(applications(db, { now }).map((a) => [a.id, a]));
  assert.equal(Object.keys(apps).length, 4);
  assert.deepEqual(apps[byEmail].responded, { reached: true, date: '2026-09-05' });
  assert.deepEqual([apps[byStatus].interview.date, apps[byStatus].responded.date], ['2026-09-20', '2026-09-20']);
  assert.deepEqual([apps[rejected].rejected.reached, apps[rejected].responded.reached, apps[rejected].closed], [true, true, true]);
  assert.equal(apps[ackOnly].responded.reached, false, 'a confirmation, or an email still in review, is not a response');
  assert.equal(apps[ackOnly].noReply, true);

  const f = funnel(db, { now });
  assert.deepEqual(f.totals, { found: 5, scored7: 0, applied: 4, responded: 3, interview: 1, offer: 0, rejected: 1, noReply: 1 });
  assert.equal(f.rates.response, 0.75);
  assert.deepEqual([f.medians.daysToResponse, f.medians.responseSamples], [10, 3]); // 4, 10, 10 days
  store.close();
});

test('an added status in the In conversation group counts as an interview; imported history counts but is not timed', () => {
  const { store, db, job, history } = setup();
  addValue(db, 'status', { label: 'Phone screen', group: 'conversation' });
  const screen = job({ applied: '2026-09-01', status: 'phone_screen' });
  history(screen, 'phone_screen', '2026-09-08');
  const imported = job({ applied: '2026-08-01', status: 'offer' });
  history(imported, 'offer', '2026-09-30', 'import');
  const f = funnel(db, { now });
  assert.deepEqual([f.totals.interview, f.totals.offer], [1, 1]);
  assert.deepEqual([f.medians.daysToInterview, f.medians.interviewSamples], [7, 1]);
  assert.equal(applications(db, { now }).find((a) => a.id === imported).offer.date, null);
  store.close();
});

test('filters, by-source results, weekly counts, and the follow-up list', () => {
  const { store, db, job, email } = setup();
  const old = job({ applied: '2026-06-01', source: 'Himalayas' });
  const recent = job({ applied: '2026-09-28', source: 'Himalayas' });
  email(recent, 'interview_request', '2026-09-30');
  const stale = job({ applied: '2026-09-15', source: 'LinkedIn' });
  job({ applied: '2026-09-29', source: 'manual', track: 'fractional' });
  job({ applied: '2026-09-29', source: 'Manual', track: 'fractional', status: 'new' });

  assert.equal(funnel(db, { now }).totals.applied, 5);
  assert.equal(funnel(db, { now, days: 30 }).totals.applied, 4);
  assert.equal(funnel(db, { now, days: 30, track: 'fractional' }).totals.applied, 2);

  const f = funnel(db, { now });
  assert.deepEqual(f.bySource.map((s) => [s.source, s.applied, s.responded]), [['Himalayas', 2, 1], ['manual', 2, 0], ['LinkedIn', 1, 0]]);
  assert.equal(f.weeks.length, 12);
  assert.equal(f.weeks.at(-1).weekStart, '2026-10-05');
  assert.equal(f.weeks.find((w) => w.weekStart === '2026-09-28').applied, 3);
  assert.deepEqual(f.followUps.map((x) => [x.id, x.days]), [[old, 126], [stale, 20]]);
  assert.ok(f.followUps.every((x) => x.days >= 14));
  assert.equal(applications(db, { now }).find((a) => a.id === stale).noReply, 20 >= NO_REPLY_DAYS);
  store.close();
});

test('GET /api/funnel applies the window and track, and rejects bad values', async () => {
  const { buildApp } = await import('../server/app.js');
  const { store, job } = setup();
  job({ applied: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) });
  job({ applied: '2025-01-01' });
  const app = await buildApp({ store, config: { search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null } });
  assert.equal((await app.inject('/api/funnel?days=all')).json().totals.applied, 2);
  assert.equal((await app.inject('/api/funnel?days=30')).json().totals.applied, 1);
  assert.equal((await app.inject('/api/funnel?days=30&track=fractional')).json().totals.applied, 0);
  assert.equal((await app.inject('/api/funnel?days=7')).statusCode, 400);
  await app.close();
  store.close();
});
