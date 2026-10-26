// Failure emails (server/alerts.js) and header safety in the email builder. A fake sender; nothing is emailed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { createAlerts } from '../server/alerts.js';
import { createScheduler, parseSchedule } from '../server/scheduler.js';
import { buildRawEmail } from '../tools/google/gmail.js';

const local = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h);

function setup(clock = () => local(2026, 10, 25)) {
  const { db } = openJobStore(':memory:');
  const sent = [];
  const alerts = createAlerts({ db, send: async (e) => sent.push(e), to: () => 'owner@example.com', appUrl: () => 'https://jobs.example.com', clock, log: {} });
  return { db, sent, alerts };
}

test('a failed scheduled job emails once a day; a success clears it so the next failure emails again', async () => {
  let now = local(2026, 10, 25, 6);
  const { sent, alerts } = setup(() => now);
  await alerts.jobResult('pipeline', false, 'Scoring stopped: the monthly Claude budget is used up');
  await alerts.jobResult('pipeline', false, 'again');
  assert.equal(sent.length, 1, 'one email per kind per day');
  assert.deepEqual([sent[0].to, sent[0].subject], ['owner@example.com', 'Job Agent: the scheduled pipeline failed']);
  assert.match(sent[0].text, /budget is used up/);
  assert.match(sent[0].text, /https:\/\/jobs\.example\.com\/#\/activity/);
  now = local(2026, 10, 26, 6);
  await alerts.jobResult('pipeline', false, 'still failing');
  assert.equal(sent.length, 2, 'a new day, a new email');
  await alerts.jobResult('pipeline', true, null);
  await alerts.jobResult('pipeline', false, 'failed again after recovering');
  assert.equal(sent.length, 3, 'after recovery the same day, it emails again');
  await alerts.jobResult('backup', false, 'Drive refused');
  assert.equal(sent.at(-1).subject, 'Job Agent: the nightly backup failed', 'each job is its own kind');
});

test('once: an ongoing problem emails a single time until it recovers', async () => {
  let now = local(2026, 10, 25);
  const { sent, alerts } = setup(() => now);
  await alerts.alert('geo-db', 'US-only blocking is off', 'missing', { once: true });
  now = local(2026, 10, 28);
  await alerts.alert('geo-db', 'US-only blocking is off', 'missing', { once: true });
  assert.equal(sent.length, 1);
  alerts.recovered('geo-db');
  await alerts.alert('geo-db', 'US-only blocking is off', 'missing', { once: true });
  assert.equal(sent.length, 2);
});

test('no address or a failing send: recorded, never thrown', async () => {
  const { db } = openJobStore(':memory:');
  const quiet = createAlerts({ db, send: async () => { throw new Error('Gmail down'); }, to: () => 'owner@example.com', log: {} });
  assert.equal(await quiet.alert('job:inbox', 'x', 'y'), false);
  const none = createAlerts({ db, send: async () => assert.fail('no address, no email'), to: () => null, log: {} });
  assert.equal(await none.alert('job:backup', 'x', 'y'), false);
});

test('the scheduler reports each run to the alerts, and a reporting problem never changes the job result', async () => {
  const reports = [];
  let clock = local(2026, 10, 25, 5, 59);
  const scheduler = createScheduler({
    jobs: [
      { name: 'backup', schedule: parseSchedule('daily 06:00'), run: async () => { throw new Error('Drive refused'); }, lastRanAt: () => local(2026, 10, 24, 6).toISOString() },
      { name: 'inbox', schedule: parseSchedule('daily 06:00'), run: async () => {}, lastRanAt: () => local(2026, 10, 24, 6).toISOString() },
    ],
    now: () => clock,
    log: {},
    every: () => null,
    onResult: (name, ok, error) => {
      reports.push([name, ok, error]);
      throw new Error('the alert itself broke');
    },
  }).start();
  clock = local(2026, 10, 25, 6, 1);
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(reports.sort(), [['backup', false, 'Drive refused'], ['inbox', true, null]]);
  assert.deepEqual(scheduler.status().map((j) => j.lastResult), ['failed', 'ok']);
});

test('email headers never gain a line: subjects lose control characters, addresses with them are refused', () => {
  const raw = Buffer.from(buildRawEmail({ to: 'owner@example.com', subject: 'Hi\r\nBcc: someone@example.com', text: 'x' }), 'base64url').toString('utf8');
  const headers = raw.split('\r\n\r\n')[0].split('\r\n');
  assert.deepEqual(headers.slice(0, 2), ['To: owner@example.com', 'Subject: Hi Bcc: someone@example.com']);
  assert.ok(!headers.some((h) => h.startsWith('Bcc:')));
  assert.throws(() => buildRawEmail({ to: 'owner@example.com\r\nBcc: x@example.com', subject: 's', text: 'x' }), /control characters/);
});
