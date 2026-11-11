// Home's Today list (server/today.ts): reminders due, offers, and follow-ups, in order, for the current user only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openJobStore } from '../db/index.ts';
import { buildApp } from '../server/app.ts';
import { today, REMINDER_DAYS } from '../server/today.ts';
import { FOLLOW_UP_DAYS } from '../server/funnel.ts';
import { addUser } from '../db/users.ts';
import { runAsUser } from '../db/scope.ts';
import { fakeConfig, fakeServices } from './fixtures/fakes.js';
/** @typedef {{ kind: string, text: string, company?: string, count?: number, staleDays?: number, overdue?: boolean, id?: string }} Item */

// Synthetic data only; "now" is fixed so due dates and waiting days are stable.
const now = new Date('2026-10-26T12:00:00Z');
const daysAgo = (/** @type {number} */ n) => new Date(now.getTime() - n * 864e5).toISOString().slice(0, 10);
const inDays = (/** @type {number} */ n) => new Date(now.getTime() + n * 864e5).toISOString();

function setup() {
  const store = openJobStore(':memory:');
  const { db } = store;
  const job = async (/** @type {Record<string, string | null>} */ o = {}) =>
    Number(
      (await db
        .prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, source, track, discovered_on, stage, status, applied_on, created_at, updated_at)
          VALUES (@uid, @k, @company, @title, @k, 'LinkedIn', 'fulltime', '2026-09-01', @stage, @status, @applied, 'x', 'x')`)
        .run({ uid: 1, k: `k${Math.random()}`, company: 'Example Co', title: 'CTO', stage: 'pipeline', status: 'applied', applied: null, ...o })).id,
    );
  /** @param {number} postingId @param {string} kind @param {string} due @param {Record<string, string | null>} [o] */
  const reminder = async (postingId, kind, due, o = {}) =>
    await db.prepare(`INSERT INTO reminders (user_id, id, posting_id, kind, due_at, note, status, created_at) VALUES (@uid, @id, @postingId, @kind, @due, @note, @status, 'x')`)
      .run({ uid: 1, id: randomUUID(), postingId, kind, due, note: null, status: 'open', ...o });
  return { store, db, job, reminder };
}

test('order: past-due reminders, offers, upcoming reminders by date, then follow-ups oldest first; nothing else', async () => {
  const { store, db, job, reminder } = setup();
  const later = await job({ company: 'Later Co', status: 'interviewing', applied: daysAgo(20) });
  await reminder(later, 'interview', inDays(5), { note: 'Panel interview' });
  const soon = await job({ company: 'Soon Co', status: 'interviewing', applied: daysAgo(20) });
  await reminder(soon, 'assessment', inDays(2));
  const late = await job({ company: 'Late Co', status: 'interviewing', applied: daysAgo(30) });
  await reminder(late, 'assessment', inDays(-1), { note: 'Send the 90 day plan' });
  await reminder(late, 'interview', inDays(REMINDER_DAYS + 3)); // too far out
  await reminder(late, 'interview', inDays(1), { status: 'done' }); // closed
  await job({ company: 'Offer Co', status: 'offer', applied: daysAgo(40) });
  await job({ company: 'Old Offer Co', status: 'offer', stage: 'archived', applied: daysAgo(90) }); // archived: not shown
  await job({ company: 'Waiting Co', applied: daysAgo(FOLLOW_UP_DAYS + 10) });
  await job({ company: 'Newer Co', applied: daysAgo(FOLLOW_UP_DAYS) });
  await job({ company: 'Fresh Co', applied: daysAgo(3) }); // too soon to follow up
  await job({ company: 'Parked Co', stage: 'archived', applied: daysAgo(20) }); // archived: no follow-up
  await job({ company: 'Ghost Co', applied: daysAgo(60) }); // stale: one Close item for all of them
  await job({ company: 'Ghost Archived Co', stage: 'archived', applied: daysAgo(90) }); // stale too
  await job({ company: 'Closed Co', status: 'rejected', applied: daysAgo(30) });

  const items = /** @type {Item[]} */ ((await today(db, { now })).items);
  assert.deepEqual(items.map((t) => `${t.kind}:${t.company}`), [
    'assessment:Late Co',
    'offer:Offer Co',
    'assessment:Soon Co',
    'interview:Later Co',
    'follow_up:Waiting Co',
    'follow_up:Newer Co',
    'stale:undefined',
  ]);
  assert.deepEqual([items.at(-1)?.count, items.at(-1)?.staleDays], [2, 45]);
  assert.match(String(items.at(-1)?.text), /2 applications with no reply after 45 days/);
  assert.equal(items[0].overdue, true);
  assert.equal(items[0].text, 'Send the 90 day plan');
  assert.equal(items[2].text, 'Assessment', 'no note: the kind');
  assert.match(items[4].text, new RegExp(`No reply in ${FOLLOW_UP_DAYS + 10} days`));
  store.close();
});

test('the summary carries the list, and another user sees only their own', async () => {
  const { store, job, reminder } = setup();
  const id = await job({ company: 'Mine Co', status: 'interviewing', applied: daysAgo(5) });
  await reminder(id, 'interview', inDays(1));
  const app = await buildApp({ store, config: fakeConfig({ search: { homeLocations: [] }, fractional: {} }), services: fakeServices({ createBrowser: async () => null }) });
  const t = (await app.inject('/api/summary')).json().today;
  assert.ok(t.some((/** @type {Item} */ x) => x.company === 'Mine Co'));
  const other = await runAsUser(await addUser(store.admin, { email: 'b@example.com' }), async () => (await today(store.db, { now })).items);
  assert.deepEqual(other, []);
  await app.close();
  store.close();
});

test("one job's next steps: every open reminder however far out, its offer or follow-up, and nothing from other jobs", async () => {
  const { store, db, job, reminder } = setup();
  const target = await job({ company: 'Target Co', status: 'interviewing', applied: daysAgo(30) });
  await reminder(target, 'interview', inDays(REMINDER_DAYS + 20), { note: 'Final round' }); // past Home's horizon, still shown here
  await reminder(target, 'assessment', inDays(1), { status: 'done' });
  const other = await job({ company: 'Other Co', status: 'interviewing', applied: daysAgo(30) });
  await reminder(other, 'interview', inDays(1));
  const offer = await job({ company: 'Offer Co', status: 'offer', applied: daysAgo(40) });
  const waiting = await job({ company: 'Waiting Co', applied: daysAgo(FOLLOW_UP_DAYS + 2) });

  const steps = /** @type {Item[]} */ ((await today(db, { now, jobId: target })).items);
  assert.deepEqual(steps.map((t) => [t.kind, t.text]), [['interview', 'Final round']]);
  assert.ok(steps[0].id, 'a reminder carries its id, for Done');
  assert.deepEqual((await today(db, { now, jobId: offer })).items.map((t) => t.kind), ['offer']);
  assert.deepEqual((await today(db, { now, jobId: waiting })).items.map((t) => t.kind), ['follow_up']);
  assert.equal((await today(db, { now })).items.some((t) => t.text === 'Final round'), false, "Home's list keeps its 14-day horizon");

  const app = await buildApp({ store, config: fakeConfig({ search: { homeLocations: [] }, fractional: {} }), services: fakeServices({ createBrowser: async () => null }) });
  const detail = (await app.inject(`/api/postings/${target}`)).json();
  assert.deepEqual(detail.nextSteps.map((/** @type {Item} */ t) => t.text), ['Final round'], 'the job panel gets them with the job');
  await app.close();
  store.close();
});
