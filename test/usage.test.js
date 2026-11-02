// The admin's private weekly totals (server/admin-queries.js usageByWeek, GET /api/admin/usage): counts across every
// account, placed by local week, with nothing about who or which job. Made-up accounts and jobs; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openJobStore } from '../db/index.js';
import { addUser } from '../db/users.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { usageByWeek } from '../server/admin-queries.js';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.js';

const SITE = 'http://localhost:5178';
const OWNER = 'owner@example.com';
const NOW = new Date('2026-10-28T12:00:00Z'); // a Wednesday; this week starts Monday 2026-10-26

function seed(db) {
  const pat = addUser(db, { email: 'pat@example.com', name: 'Pat' });
  const sam = addUser(db, { email: 'sam@example.com', name: 'Sam' });
  let n = 0;
  const job = (uid, at) =>
    Number(
      db.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
          VALUES (?, ?, 'Example Co', 'Secret Title', ?, ?, ?, ?)`).run(uid, `example.com/${(n += 1)}`, `example|${n}`, at.slice(0, 10), at, at).lastInsertRowid,
    );
  const run = (uid, name, status, at) => db.prepare('INSERT INTO runs (name, status, started_at, user_id) VALUES (?, ?, ?, ?)').run(name, status, at, uid);
  const artifact = (uid, posting, kind, source, at) =>
    db.prepare('INSERT INTO artifacts (user_id, posting_id, kind, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(uid, posting, kind, 'Private letter text', source, at);
  const prep = (uid, posting, at) =>
    db.prepare("INSERT INTO meeting_preps (id, user_id, posting_id, attendees_json, content, model, created_at) VALUES (?, ?, ?, '[]', 'Private prep', 'm', ?)").run(`prep-${(n += 1)}`, uid, posting, at);

  // This week: Pat adds two jobs, gets a letter written and one saved by hand, and a prep; a pipeline completes (partial
  // counts as completed) and one fails; Sam only visits.
  const a = job(pat, '2026-10-26T15:00:00Z');
  job(pat, '2026-10-27T15:00:00Z');
  artifact(pat, a, 'cover_letter', 'v2', '2026-10-27T16:00:00Z');
  artifact(pat, a, 'cover_letter', 'user', '2026-10-27T17:00:00Z');
  artifact(pat, a, 'analysis', 'v2', '2026-10-27T16:00:00Z');
  prep(pat, a, '2026-10-28T10:00:00Z');
  run(pat, 'pipeline', 'partial', '2026-10-26T11:00:00Z');
  run(1, 'pipeline', 'failed', '2026-10-27T11:00:00Z');
  db.prepare("UPDATE users SET last_seen_at = '2026-10-28T09:00:00Z' WHERE id = ?").run(sam);

  // Last week: one completed run by the owner, a v1 letter (an import, not counted), and a job.
  const b = job(1, '2026-10-21T15:00:00Z');
  run(1, 'pipeline', 'ok', '2026-10-20T11:00:00Z');
  run(1, 'score', 'ok', '2026-10-20T12:00:00Z');
  artifact(1, b, 'cover_letter', 'v1', '2026-10-21T16:00:00Z');

  // Before the window: not counted.
  job(pat, '2026-01-05T15:00:00Z');
  return { pat, sam };
}

test('weekly totals: runs, jobs, letters, preps, and accounts seen, by local week, newest first', () => {
  const store = openJobStore(':memory:');
  seed(store.raw);
  const weeks = usageByWeek(store.raw, { weeks: 3, now: NOW });
  assert.deepEqual(weeks, [
    { weekStart: '2026-10-26', pipelineCompleted: 1, pipelineFailed: 1, jobsAdded: 2, lettersWritten: 2, prepsWritten: 1, accountsSeen: 3 },
    { weekStart: '2026-10-19', pipelineCompleted: 1, pipelineFailed: 0, jobsAdded: 1, lettersWritten: 0, prepsWritten: 0, accountsSeen: 1 },
    { weekStart: '2026-10-12', pipelineCompleted: 0, pipelineFailed: 0, jobsAdded: 0, lettersWritten: 0, prepsWritten: 0, accountsSeen: 0 },
  ]);
  // Counts only: nothing about who or which job.
  const text = JSON.stringify(usageByWeek(store.raw, { weeks: 52, now: NOW }));
  for (const secret of ['pat@example.com', 'Pat', 'Secret Title', 'Example Co', 'Private']) assert.ok(!text.includes(secret), secret);
  assert.equal(usageByWeek(store.raw, { weeks: 52, now: NOW }).length, 52);
  store.close();
});

test('GET /api/admin/usage: the admin only, with a bounded number of weeks', async () => {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: OWNER, SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  seed(store.raw);
  const app = await buildApp({ store, config: { candidate: { name: 'O' }, search: { homeLocations: [] }, fractional: {} }, authMode: 'google', auth: { settings }, services: { createBrowser: async () => null, log: { info() {}, warn() {}, error() {} } } });
  const as = (email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE });

  assert.equal((await app.inject({ url: '/api/admin/usage', headers: as('pat@example.com') })).statusCode, 403, 'a member cannot read it');
  assert.equal((await app.inject({ url: '/api/admin/usage' })).statusCode, 401, 'signed out');
  const res = await app.inject({ url: '/api/admin/usage?weeks=4', headers: as(OWNER) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().length, 4);
  assert.deepEqual(Object.keys(res.json()[0]).sort(), ['accountsSeen', 'jobsAdded', 'lettersWritten', 'pipelineCompleted', 'pipelineFailed', 'prepsWritten', 'weekStart']);
  assert.equal((await app.inject({ url: '/api/admin/usage', headers: as(OWNER) })).json().length, 12, 'twelve weeks by default');
  assert.equal((await app.inject({ url: '/api/admin/usage?weeks=53', headers: as(OWNER) })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/admin/usage?weeks=0', headers: as(OWNER) })).statusCode, 400);
  await app.close();
  store.close();
});
