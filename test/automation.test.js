// Settings > Automatic runs (agents/automation.ts, server/app.ts): each user's own pipeline times, the Claude steps a
// scheduled run leaves out, the owner's inbox checks, and Off (manual runs only). Made-up accounts; the pipeline is a
// stand-in, so nothing reaches the network or Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openJobStore } from '../db/index.ts';
import { addUser, OWNER_ID } from '../db/users.ts';
import { buildApp } from '../server/app.ts';
import { authSettings } from '../server/auth.ts';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.ts';
import { createScheduler, parseSchedule, schedulesFromEnv } from '../server/scheduler.ts';
import { automatedUsers, automationFor, saveAutomation, skipArgs } from '../agents/automation.ts';
import { fakeConfig, fakeServices, noTimer } from './fixtures/fakes.js';

const NONE = { pipeline: null, inbox: null };
const SITE = 'http://localhost:5178';

test('defaults: the owner from .env, anyone else from the old checkbox; saved values win; bad ones are refused', async () => {
  const { admin: db } = openJobStore(':memory:');
  const b = await addUser(db, { email: 'b@example.com', name: 'Sam' });
  const env = { pipeline: 'Mon,Thu 06:00', inbox: 'daily 12:00' };

  assert.deepEqual(await automationFor(db, OWNER_ID, env), { on: true, pipeline: 'Mon,Thu 06:00', steps: { score: true, letters: true }, inbox: { afterPipeline: true, schedule: 'daily 12:00' }, saved: false });
  assert.equal((await automationFor(db, OWNER_ID, NONE)).on, false, 'no .env schedule: the owner starts on manual runs only');
  assert.deepEqual(await automationFor(db, b, env), { on: false, pipeline: 'Mon,Thu 06:00', steps: { score: true, letters: true }, inbox: null, saved: false });
  await db.prepare("INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, 'schedule.pipeline', 'on', 'x')").run(b);
  assert.equal((await automationFor(db, b, env)).on, true, "the old checkbox carries over, on the app's default times");

  const saved = await saveAutomation(db, OWNER_ID, { on: false, pipeline: 'weekdays 7:30', steps: { score: false }, inbox: { afterPipeline: false, schedule: null } });
  assert.deepEqual(saved, { on: false, pipeline: 'weekdays 7:30', steps: { score: false, letters: true }, inbox: { afterPipeline: false, schedule: null }, saved: true });
  assert.deepEqual(await automationFor(db, OWNER_ID, env), saved, 'what was saved replaces the .env defaults, Off included');

  await assert.rejects(saveAutomation(db, b, { on: true, pipeline: 'Funday 06:00' }), { statusCode: 400, message: /pipeline schedule/ });
  await assert.rejects(saveAutomation(db, b, { on: true, pipeline: 'Mon 06:00', inbox: { afterPipeline: true } }), { statusCode: 400 });
  assert.equal((await automationFor(db, b, env)).saved, false, 'a refused save stores nothing');

  // A saved value that no longer parses is read as no time, never an error that stops the scheduler.
  await db.prepare("INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, 'automation', ?, 'x')").run(b, JSON.stringify({ on: true, pipeline: 'nonsense' }));
  assert.deepEqual([(await automationFor(db, b, env)).on, (await automationFor(db, b, env)).pipeline], [true, null]);

  assert.deepEqual((await automatedUsers(db, env)).map((u) => u.uid), [b], 'the owner is off; B is on');
  await db.prepare("UPDATE users SET status = 'paused' WHERE id = ?").run(b);
  assert.deepEqual(await automatedUsers(db, env), [], 'a paused account runs nothing');

  assert.deepEqual(skipArgs({ score: true, letters: true }), []);
  assert.deepEqual(skipArgs({ score: false, letters: false }), ['--no-score', '--no-letters']);
});

test('scheduler set(): add, replace in place (keeping the next time when unchanged), and remove', async () => {
  let t = new Date(2026, 10, 2, 5, 0); // a Monday, 5:00

  const s = createScheduler({ jobs: [], now: () => t, every: () => noTimer(), clear: () => {}, log: {} }); // never started: tick by hand
  const job = (/** @type {string} */ spec, /** @type {() => Promise<unknown>} */ run = async () => {}) => ({ name: 'pipeline:5', schedule: parseSchedule(spec), run, lastRanAt: () => null });
  s.set('pipeline:5', job('Mon 06:00'));
  const first = s.status()[0].next;
  t = new Date(2026, 10, 2, 6, 0, 10); // due, before the next tick
  s.set('pipeline:5', job('Mon 06:00'));
  assert.equal(s.status()[0].next, first, 'a resync just after the time keeps it, so the run is not skipped');
  /** @type {() => void} */
  let release = () => {};
  let runs = 0;
  s.set('pipeline:5', job('Mon 06:00', () => { runs += 1; return new Promise((r) => { release = () => r(undefined); }); }));
  s.tick();
  assert.equal(s.status()[0].running, true);
  s.set('pipeline:5', job('Tue 06:00'));
  assert.equal(s.status()[0].schedule, 'Tue 06:00');
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([runs, s.status()[0].running], [1, false], 'the run in progress clears its own running flag');
  s.set('pipeline:5', null);
  assert.deepEqual(s.names(), []);
});

/** The minute just passed, as a daily spec: a job never run counts as missed and catches up when the server starts. */
const justPassed = () => {
  const d = new Date(Date.now() - 60000);
  return `daily ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

async function setup() {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  const b = await addUser(store.admin, { email: 'b@example.com', name: 'Sam' });
  const c = await addUser(store.admin, { email: 'c@example.com', name: 'Cam' });
  const spec = justPassed();
  // B: on, the same minute as the owner, without scoring. C: off (manual runs only).
  await saveAutomation(store.admin, b, { on: true, pipeline: spec, steps: { score: false } });
  await saveAutomation(store.admin, c, { on: false, pipeline: spec });
  /** @type {Array<{ user: number, args: string[], at: 'start' | 'end' }>} */
  const events = [];
  const app = await buildApp({
    store,
    config: fakeConfig({ candidate: { name: 'Owner Example' }, search: { homeLocations: [] }, fractional: {}, coverLetterChecks: [] }),
    authMode: 'google',
    auth: { settings },
    services: fakeServices({
      createBrowser: async () => null,
      runPipeline: async ({ user, args = [] }) => {
        events.push({ user, args, at: 'start' });
        await new Promise((r) => setTimeout(r, 30));
        events.push({ user, args, at: 'end' });
        return { code: 0, lastError: null };
      },
      schedules: schedulesFromEnv({ SCHEDULE_PIPELINE: spec }),
      log: { info() {}, warn() {}, error() {} },
    }),
  });
  const as = (/** @type {string} */ email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE });
  return { store, app, b, c, events, asA: as('owner@example.com'), asB: as('b@example.com'), asC: as('c@example.com'), done: async () => { await app.close(); store.close(); } };
}

test('each user runs on their own times, one pipeline at a time, without the Claude steps they turned off; Off runs nothing', async () => {
  const { app, store, b, events, asA, asB, asC, done } = await setup();
  await app.ready();
  for (let i = 0; i < 100 && events.filter((e) => e.at === 'end').length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    events.map((e) => `${e.at} ${e.user}`),
    [`start ${OWNER_ID}`, `end ${OWNER_ID}`, `start ${b}`, `end ${b}`],
    'both came due at once: the owner first, then B, never at the same time; C (off) never ran',
  );
  assert.deepEqual(events.find((e) => e.user === b)?.args, ['--no-score'], 'B turned scoring off for scheduled runs');
  assert.deepEqual(events.find((e) => e.user === OWNER_ID)?.args, [], 'the owner kept every step');

  // Each sees their own automatic runs, never another user's.
  const pipelineOf = async (/** @type {Record<string, string>} */ headers) => (await app.inject({ url: '/api/pipeline', headers })).json();
  assert.deepEqual([(await pipelineOf(asA)).automatic, (await pipelineOf(asB)).automatic, (await pipelineOf(asC)).automatic], [true, true, false]);
  const names = async (/** @type {Record<string, string>} */ headers) => (await app.inject({ url: '/api/schedule', headers })).json().jobs.map((/** @type {{ name: string }} */ j) => j.name);
  assert.deepEqual(await names(asA), ['pipeline']);
  assert.deepEqual(await names(asB), [`pipeline:${b}`]);
  assert.deepEqual(await names(asC), []);

  // Settings: the owner may set the inbox; B may not. Turning B off takes B's job away at once.
  const put = (/** @type {Record<string, string>} */ headers, /** @type {object} */ payload) => app.inject({ method: 'PUT', url: '/api/account/automation', headers, payload });
  assert.equal((await put(asB, { on: true, inbox: { afterPipeline: true, schedule: null } })).statusCode, 400);
  const off = (await put(asB, { on: false, pipeline: 'Mon 06:00' })).json();
  assert.deepEqual([off.on, off.next.pipeline, off.owner], [false, null, false]);
  assert.deepEqual(await names(asB), []);
  assert.equal((await pipelineOf(asB)).automatic, false);
  const on = (await put(asB, { on: true, pipeline: 'Mon 06:00' })).json();
  assert.ok(on.next.pipeline, 'on again, with its next run');
  const mine = (await app.inject({ url: '/api/account/automation', headers: asA })).json();
  assert.deepEqual([mine.owner, mine.inbox, mine.saved], [true, { afterPipeline: true, schedule: null }, false]);
  assert.equal((await put(asA, { on: true, pipeline: 'Tue 07:00', inbox: { afterPipeline: false, schedule: 'daily 12:00' } })).statusCode, 200);

  // A paused account drops out at the next sync (any save resyncs everyone).
  await store.admin.prepare("UPDATE users SET status = 'paused' WHERE id = ?").run(b);
  await put(asA, { on: true, pipeline: 'Tue 07:00' });
  assert.equal((await pipelineOf(asB)).automatic, false);
  await done();
});
