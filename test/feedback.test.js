// Multi-user, phase 4: feedback to the owner, the Users screen's activity and setup columns, and the admin's count on
// Home. Made-up accounts; email is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openJobStore } from '../db/index.js';
import { addUser } from '../db/users.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { createNotices } from '../server/notices.js';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.js';
import { FEEDBACK_PER_DAY } from '../server/feedback-routes.js';
import { saveUserConfig, saveUserProfile } from '../agents/user-config.js';
import { buildRawEmail } from '../tools/google/gmail.js';

const SITE = 'http://localhost:5178';
const OWNER = 'owner@example.com';

async function setup() {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: OWNER, SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  const sent = [];
  const notices = createNotices({ send: async (e) => sent.push(e), owner: () => OWNER, appUrl: () => SITE, log: {} });
  const app = await buildApp({ store, config: { candidate: { name: 'O' }, search: { homeLocations: [] }, fractional: {} }, authMode: 'google', auth: { settings }, services: { createBrowser: async () => null, notices, log: { info() {}, warn() {}, error() {} } } });
  const as = (email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE });
  const pat = addUser(store.raw, { email: 'pat@example.com', name: 'Pat' });
  return { store, app, sent, pat, asOwner: as(OWNER), asPat: as('pat@example.com'), done: async () => { await app.close(); store.close(); } };
}

test('feedback: saved as the sender\'s, emailed to the owner with the sender as reply-to, listed and closed by the admin', async () => {
  const { store, app, sent, pat, asOwner, asPat, done } = await setup();
  const send = (headers, body) => app.inject({ method: 'POST', url: '/api/feedback', headers, payload: body });
  assert.equal((await send(asPat, { body: '   ' })).statusCode, 400);
  const res = await send(asPat, { body: 'The Settings page could use an example.', page: '#/settings<script>' });
  assert.equal(res.statusCode, 201);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].to, sent[0].replyTo, sent[0].subject], [OWNER, 'pat@example.com', 'Job Hunt: feedback from Pat']);
  assert.match(sent[0].text, /could use an example/);
  const row = store.raw.prepare('SELECT user_id, page, status FROM feedback').get();
  assert.deepEqual(row, { user_id: pat, page: '#/settingsscript', status: 'open' }, 'the page label keeps only plain characters');

  assert.equal((await app.inject({ url: '/api/admin/feedback', headers: asPat })).statusCode, 403, 'a user cannot read feedback');
  const list = (await app.inject({ url: '/api/admin/feedback', headers: asOwner })).json();
  assert.deepEqual([list.length, list[0].email, list[0].status], [1, 'pat@example.com', 'open']);
  assert.deepEqual((await app.inject({ url: '/api/summary', headers: asOwner })).json().adminWaiting, { requests: 0, feedback: 1 });
  assert.equal((await app.inject({ url: '/api/summary', headers: asPat })).json().adminWaiting, undefined, 'only an admin sees the count');
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/feedback/${list[0].id}/done`, headers: asPat })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/feedback/${list[0].id}/done`, headers: asOwner })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/api/admin/feedback/${list[0].id}/done`, headers: asOwner })).statusCode, 404, 'once');

  // The owner's own feedback is a note to self; and a day's sending is capped.
  await send(asOwner, { body: 'note to self' });
  assert.equal(sent.length, 1);
  for (let i = 1; i < FEEDBACK_PER_DAY; i += 1) await send(asPat, { body: `more ${i}` });
  assert.equal((await send(asPat, { body: 'one too many' })).statusCode, 429);
  assert.equal(sent.length, FEEDBACK_PER_DAY);
  await done();
});

test('the Users screen: last seen, last pipeline run, and setup; no one\'s background or key text', async () => {
  const { store, app, pat, asOwner, asPat, done } = await setup();
  await app.inject({ url: '/api/postings', headers: asPat });
  saveUserConfig(store.raw, pat, { search: { terms: ['Head of Data'], relevantTitleKeywords: ['data'], homeLocations: ['Remote'] } }, 'Pat');
  saveUserProfile(store.raw, pat, 'A private background sentence. '.repeat(30));
  store.raw.prepare("INSERT INTO runs (name, status, started_at, user_id) VALUES ('pipeline', 'ok', '2026-10-26T10:00:00Z', ?)").run(pat);
  const res = await app.inject({ url: '/api/admin/users', headers: asOwner });
  const p = res.json().find((u) => u.email === 'pat@example.com');
  assert.ok(p.lastSeenAt, 'seen');
  assert.deepEqual(p.lastRun, { status: 'ok', startedAt: '2026-10-26T10:00:00Z' });
  assert.deepEqual(p.setup, { searchReady: true, profileReady: true, scheduled: false });
  assert.equal(res.json().find((u) => u.owner).setup, null);
  assert.ok(!res.body.includes('private background'), "the admin sees whether it is filled in, not what it says");
  await done();
});

test('reply-to is one plain address or nothing', () => {
  const raw = (o) => Buffer.from(buildRawEmail({ to: OWNER, subject: 's', text: 'x', ...o }), 'base64url').toString('utf8');
  assert.match(raw({ replyTo: 'pat@example.com' }), /\r\nReply-To: pat@example\.com\r\n/);
  assert.ok(!/Reply-To/.test(raw({})));
  for (const bad of ['pat@example.com\r\nBcc: x@example.com', 'a@example.com, b@example.com', 'Pat <pat@example.com>']) {
    assert.throws(() => raw({ replyTo: bad }), /one plain address/, bad);
  }
});
