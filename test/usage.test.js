// The admin's private weekly totals (server/admin-queries.ts usageByWeek, GET /api/admin/usage): counts across every
// account, placed by local week, with nothing about who or which job. Made-up accounts and jobs; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openJobStore } from '../db/index.ts';
import { runAsUser } from '../db/scope.ts';
import { addUser } from '../db/users.ts';
import { buildApp } from '../server/app.ts';
import { authSettings } from '../server/auth.ts';
import { usageByWeek } from '../server/admin-queries.ts';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.ts';
import { localDay } from '../tools/dates.ts';
import { fakeConfig, fakeServices } from './fixtures/fakes.js';
/** @import { Db } from '../tools/types.ts' */

const SITE = 'http://localhost:5178';
const OWNER = 'owner@example.com';
const NOW = new Date('2026-10-28T18:00:00Z'); // a Wednesday everywhere in the Americas and in UTC
// This week runs Sunday 2026-10-25 to Saturday 2026-10-31; last week ended Saturday 2026-10-24.
const FIELDS = ['accountsSeen', 'claudeSpendUsd', 'feedbackReceived', 'jobsAdded', 'lettersWritten', 'pipelineCompleted', 'pipelineFailed', 'prepsWritten', 'weekEnding'];
// Saturday evening in the Americas, already Sunday in UTC: which week it lands in follows the app's zone.
const EDGE = '2026-10-25T03:00:00Z';

/** @param {Db} db */
async function seed(db) {
  const pat = await addUser(db, { email: 'pat@example.com', name: 'Pat' });
  const sam = await addUser(db, { email: 'sam@example.com', name: 'Sam' });
  let n = 0;
  const job = async (/** @type {number} */ uid, /** @type {string} */ at) =>
    Number(
      (await db.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
          VALUES (?, ?, 'Example Co', 'Secret Title', ?, ?, ?, ?)`).run(uid, `example.com/${(n += 1)}`, `example|${n}`, at.slice(0, 10), at, at)).id,
    );
  const run = async (/** @type {number} */ uid, /** @type {string} */ name, /** @type {string} */ status, /** @type {string} */ at) => Number((await db.prepare('INSERT INTO runs (name, status, started_at, user_id) VALUES (?, ?, ?, ?)').run(name, status, at, uid)).id);
  const call = async (/** @type {number} */ runId, /** @type {number | null} */ cost, /** @type {string} */ at) => await db.prepare("INSERT INTO run_calls (run_id, label, model, cost_usd, created_at) VALUES (?, 'scoring', 'm', ?, ?)").run(runId, cost, at);
  /** @param {number} uid @param {number} posting @param {string} kind @param {string} source @param {string} at */
  const artifact = async (uid, posting, kind, source, at) =>
    await db.prepare('INSERT INTO artifacts (user_id, posting_id, kind, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(uid, posting, kind, 'Private letter text', source, at);
  const prep = async (/** @type {number} */ uid, /** @type {number} */ posting, /** @type {string} */ at) =>
    await db.prepare("INSERT INTO meeting_preps (id, user_id, posting_id, attendees_json, content, model, created_at) VALUES (?, ?, ?, '[]', 'Private prep', 'm', ?)").run(`prep-${(n += 1)}`, uid, posting, at);
  const feedback = async (/** @type {number} */ uid, /** @type {string} */ at) => await db.prepare("INSERT INTO feedback (id, user_id, body, created_at) VALUES (?, ?, 'Private feedback text', ?)").run(`fb-${(n += 1)}`, uid, at);
  const visit = async (/** @type {number} */ uid, /** @type {string} */ at) => await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(at, uid);

  // This week: Pat adds two jobs (one on Sunday), gets a letter written and one saved by hand, and a prep; Pat's
  // pipeline completes (partial counts) with a priced and an unpriced call; the owner's fails. Sam visits and sends
  // feedback. Only a visit counts this week, so Sam is seen and Pat (no visit) is not.
  const a = await job(pat, '2026-10-25T20:00:00Z');
  await job(pat, '2026-10-27T15:00:00Z');
  await artifact(pat, a, 'cover_letter', 'v2', '2026-10-27T16:00:00Z');
  await artifact(pat, a, 'cover_letter', 'user', '2026-10-27T17:00:00Z');
  await artifact(pat, a, 'analysis', 'v2', '2026-10-27T16:00:00Z');
  await prep(pat, a, '2026-10-28T10:00:00Z');
  const patRun = await run(pat, 'pipeline', 'partial', '2026-10-26T11:00:00Z');
  await call(patRun, 0.5, '2026-10-26T11:05:00Z');
  await call(patRun, null, '2026-10-26T11:06:00Z');
  await run(1, 'pipeline', 'failed', '2026-10-27T11:00:00Z');
  await feedback(sam, '2026-10-27T12:00:00Z');
  await visit(sam, '2026-10-28T09:00:00Z');

  // Last week: the owner's completed pipeline, a scoring run with calls, a job, and a v1 letter (an import, not
  // counted); Sam adds a job on Saturday. Seen: the owner and Sam, from what they did.
  const b = await job(1, '2026-10-21T15:00:00Z');
  await run(1, 'pipeline', 'ok', '2026-10-20T11:00:00Z');
  const score = await run(1, 'score', 'ok', '2026-10-20T12:00:00Z');
  await call(score, 0.256, '2026-10-20T12:01:00Z');
  await call(score, 1, EDGE);
  await artifact(1, b, 'cover_letter', 'v1', '2026-10-21T16:00:00Z');
  await job(sam, '2026-10-24T20:00:00Z');
  await visit(1, '2026-10-19T09:00:00Z');

  // Before the window: not counted.
  await job(pat, '2026-01-05T15:00:00Z');
  await feedback(pat, '2026-01-05T15:00:00Z');
  return { pat, sam };
}

test('weekly totals across two users, Sunday to Saturday in the app zone, newest first', async () => {
  const store = openJobStore(':memory:');
  await seed(store.admin);
  const edgeLastWeek = localDay(new Date(EDGE)) === '2026-10-24';
  const weeks = await usageByWeek(store.admin, { weeks: 4, now: NOW });
  const none = { accountsSeen: 0, pipelineCompleted: 0, pipelineFailed: 0, jobsAdded: 0, lettersWritten: 0, prepsWritten: 0, feedbackReceived: 0, claudeSpendUsd: 0 };
  assert.deepEqual(weeks, [
    { weekEnding: '2026-10-31', accountsSeen: 1, pipelineCompleted: 1, pipelineFailed: 1, jobsAdded: 2, lettersWritten: 2, prepsWritten: 1, feedbackReceived: 1, claudeSpendUsd: edgeLastWeek ? 0.5 : 1.5 },
    { weekEnding: '2026-10-24', accountsSeen: 2, pipelineCompleted: 1, pipelineFailed: 0, jobsAdded: 2, lettersWritten: 0, prepsWritten: 0, feedbackReceived: 0, claudeSpendUsd: edgeLastWeek ? 1.26 : 0.26 },
    { weekEnding: '2026-10-17', ...none },
    { weekEnding: '2026-10-10', ...none },
  ]);
  // The asking admin's own zone (Settings) never moves the weeks.
  assert.deepEqual(await runAsUser(1, async () => await usageByWeek(store.admin, { weeks: 4, now: NOW }), { timeZone: 'Pacific/Kiritimati' }), weeks);

  // Totals only: the listed fields, numbers apart from the week, nothing about who or which job.
  const year = await usageByWeek(store.admin, { weeks: 52, now: NOW });
  assert.equal(year.length, 52);
  for (const row of year) {
    assert.deepEqual(Object.keys(row).sort(), FIELDS);
    for (const [k, v] of Object.entries(row)) assert.equal(typeof v, k === 'weekEnding' ? 'string' : 'number', k);
  }
  const text = JSON.stringify(year);
  for (const secret of ['pat@example.com', 'Pat', 'Sam', 'Secret Title', 'Example Co', 'Private', 'scoring']) assert.ok(!text.includes(secret), secret);
  store.close();
});

test('GET /api/admin/usage: the admin only, 4 to 52 weeks, the listed fields only', async () => {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: OWNER, SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  await seed(store.admin);
  const app = await buildApp({ store, config: fakeConfig({ candidate: { name: 'O' }, search: { homeLocations: [] }, fractional: {} }), authMode: 'google', auth: { settings }, services: fakeServices({ createBrowser: async () => null, log: { info() {}, warn() {}, error() {} } }) });
  const as = (/** @type {string} */ email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE });

  assert.equal((await app.inject({ url: '/api/admin/usage', headers: as('pat@example.com') })).statusCode, 403, 'a member cannot read it');
  assert.equal((await app.inject({ url: '/api/admin/usage' })).statusCode, 401, 'signed out');
  const res = await app.inject({ url: '/api/admin/usage?weeks=4', headers: as(OWNER) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().weeks.length, 4);
  for (const row of res.json().weeks) assert.deepEqual(Object.keys(row).sort(), FIELDS);
  assert.deepEqual(Object.keys(res.json()).sort(), ['browsers', 'devices', 'locations', 'sources', 'weeks']);
  for (const s of ['pat@example.com', 'Secret Title', 'Private']) assert.ok(!res.body.includes(s), s);
  assert.equal((await app.inject({ url: '/api/admin/usage', headers: as(OWNER) })).json().weeks.length, 12, 'twelve weeks by default');
  assert.equal((await app.inject({ url: '/api/admin/usage?weeks=52', headers: as(OWNER) })).json().weeks.length, 52);
  for (const weeks of ['3', '53', '0', 'x']) {
    assert.equal((await app.inject({ url: `/api/admin/usage?weeks=${weeks}`, headers: as(OWNER) })).statusCode, 400, weeks);
  }

  // In the OpenAPI document like every route.
  const spec = (await app.inject({ url: '/api/openapi.json', headers: as(OWNER) })).json();
  assert.ok(spec.paths['/api/admin/usage']?.get);
  await app.close();
  store.close();
});
