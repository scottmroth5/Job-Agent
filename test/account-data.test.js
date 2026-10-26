// Multi-user, phase 6: export your data, delete your account (or the owner deletes it), and pause yourself. Made-up
// accounts and data; email is faked; attached files live in a temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.js';
import { USER_TABLES } from '../db/user-tables.js';
import { addUser, OWNER_ID } from '../db/users.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { createNotices } from '../server/notices.js';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.js';
import { saveUserProfile } from '../agents/user-config.js';

const SITE = 'http://localhost:5178';
const OWNER = 'owner@example.com';

/** One job with a note, a score, a file, and a run for a user. */
function seedUser(raw, uid, dir, tag) {
  const job = Number(raw.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
    VALUES (?, ?, ?, 'CTO', ?, '2026-10-01', 'x', 'x')`).run(uid, `k-${tag}`, `${tag} Co`, `k-${tag}`).lastInsertRowid);
  raw.prepare("INSERT INTO posting_notes (user_id, id, posting_id, body, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', 'x', 'x')").run(uid, `n-${tag}`, job, `${tag} private note`);
  raw.prepare("INSERT INTO scores (user_id, posting_id, score, source, created_at) VALUES (?, ?, 8, 'v2', 'x')").run(uid, job);
  raw.prepare("INSERT INTO attachments (user_id, id, posting_id, filename, content_type, size_bytes, sha256, created_at) VALUES (?, ?, ?, 'cv.pdf', 'application/pdf', 3, 'h', 'x')").run(uid, `f-${tag}`, job);
  mkdirSync(join(dir, String(job)), { recursive: true });
  writeFileSync(join(dir, String(job), `f-${tag}`), 'pdf');
  const run = Number(raw.prepare("INSERT INTO runs (name, meta, status, started_at, user_id) VALUES ('score', ?, 'ok', 'x', ?)").run(JSON.stringify({ url: `https://${tag}.example.com` }), uid).lastInsertRowid);
  raw.prepare("INSERT INTO run_calls (run_id, label, cost_usd, created_at) VALUES (?, 'score', 0.5, ?)").run(run, new Date().toISOString());
  return { job, run };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'account-data-'));
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: OWNER, SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  const sent = [];
  const notices = createNotices({ send: async (e) => sent.push(e), owner: () => OWNER, appUrl: () => SITE, log: {} });
  const app = await buildApp({ store, config: { candidate: { name: 'O' }, search: { homeLocations: [] }, fractional: {} }, authMode: 'google', auth: { settings }, services: { createBrowser: async () => null, notices, attachmentsDir: dir, log: { info() {}, warn() {}, error() {} } } });
  const as = (email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE });
  const pat = addUser(store.raw, { email: 'pat@example.com', name: 'Pat' });
  const sam = addUser(store.raw, { email: 'sam@example.com', name: 'Sam', aiSource: 'owner' });
  const seeded = { owner: seedUser(store.raw, OWNER_ID, dir, 'Owner'), pat: seedUser(store.raw, pat, dir, 'Pat'), sam: seedUser(store.raw, sam, dir, 'Sam') };
  saveUserProfile(store.raw, pat, 'Pat background text. '.repeat(30));
  store.raw.prepare("UPDATE users SET claude_key_enc = 'v1.sealed.value.here' WHERE id = ?").run(pat);
  return { store, app, dir, sent, pat, sam, seeded, asOwner: as(OWNER), asPat: as('pat@example.com'), asSam: as('sam@example.com'), done: async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const snapshot = (raw, uid) => JSON.stringify(USER_TABLES.map((t) => raw.prepare(`SELECT * FROM "${t}" WHERE user_id = ? ORDER BY rowid`).all(uid)));

test('export: everything that is yours and nothing else; never the sealed key', async () => {
  const { app, asPat, done } = await setup();
  const res = await app.inject({ url: '/api/account/export', headers: asPat });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-disposition'], /^attachment; filename="job-hunt-export-\d{4}-\d{2}-\d{2}\.json"$/);
  const data = res.json();
  assert.deepEqual([data.account.email, data.account.claudeKeySaved], ['pat@example.com', true]);
  assert.deepEqual(data.tables.postings.map((p) => p.company), ['Pat Co']);
  assert.equal(data.tables.posting_notes[0].body, 'Pat private note');
  assert.ok(data.tables.user_settings.some((s) => s.key === 'profile.text'));
  assert.equal(data.runs.length, 1);
  assert.ok(!res.body.includes('Owner Co') && !res.body.includes('Sam Co'), "no one else's rows");
  assert.ok(!res.body.includes('v1.sealed'), 'never the sealed key');
  await done();
});

test('deleting your account: your address typed; every row and file gone; nobody else touched', async () => {
  const { store, app, dir, sent, pat, seeded, asOwner, asPat, done } = await setup();
  const others = [snapshot(store.raw, OWNER_ID), snapshot(store.raw, 3)];
  const del = (headers, confirmEmail) => app.inject({ method: 'POST', url: '/api/account/delete', headers, payload: { confirmEmail } });
  assert.equal((await del(asPat, 'someone@example.com')).statusCode, 400);
  assert.equal((await del(asOwner, OWNER)).statusCode, 400, 'the owner cannot delete themselves');
  const res = await del(asPat, ' PAT@example.com ');
  assert.deepEqual([res.statusCode, res.json().jobs], [200, 1]);
  for (const t of USER_TABLES) assert.equal(store.raw.prepare(`SELECT COUNT(*) FROM "${t}" WHERE user_id = ?`).pluck().get(pat), 0, t);
  assert.equal(store.raw.prepare('SELECT COUNT(*) FROM users WHERE id = ?').pluck().get(pat), 0);
  assert.equal(store.raw.prepare('SELECT COUNT(*) FROM runs WHERE id = ?').pluck().get(seeded.pat.run), 0, 'runs on their own key go');
  assert.equal(existsSync(join(dir, String(seeded.pat.job))), false, 'their files go');
  assert.equal(existsSync(join(dir, String(seeded.owner.job))), true, "others' files stay");
  assert.deepEqual([snapshot(store.raw, OWNER_ID), snapshot(store.raw, 3)], others, "nobody else's rows change");
  assert.deepEqual(sent.map((e) => [e.to, e.subject]), [['pat@example.com', 'Job Hunt: your account was deleted'], [OWNER, 'Job Hunt: a user deleted their account']]);
  // Signed in still, but with no account: back to requesting access.
  assert.deepEqual((await app.inject({ url: '/api/postings', headers: asPat })).json().account, 'none');
  await done();
});

test('the owner deletes an account; runs the owner paid for keep their cost (not their details)', async () => {
  const { store, app, sent, sam, seeded, asOwner, asSam, done } = await setup();
  const del = (headers, confirmEmail) => app.inject({ method: 'POST', url: `/api/admin/users/${sam}/delete`, headers, payload: { confirmEmail } });
  assert.equal((await del(asSam, 'sam@example.com')).statusCode, 403, 'admins only');
  assert.equal((await del(asOwner, 'pat@example.com')).statusCode, 400, 'the right address');
  assert.equal((await del(asOwner, 'sam@example.com')).statusCode, 200);
  const run = store.raw.prepare('SELECT user_id, meta FROM runs WHERE id = ?').get(seeded.sam.run);
  assert.deepEqual(run, { user_id: OWNER_ID, meta: null }, "the owner's key paid: kept for the cap, details dropped");
  assert.deepEqual(sent.map((e) => e.to), ['sam@example.com'], 'the owner did it, so only Sam is told');
  await done();
});

test('pausing yourself: you can still look, export, resume, or delete; a pause by the owner is theirs to lift', async () => {
  const { store, app, pat, asOwner, asPat, done } = await setup();
  const post = (url, headers, payload) => app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });
  assert.equal((await post('/api/account/pause', asPat)).json().status, 'paused');
  assert.equal((await app.inject({ url: '/api/postings', headers: asPat })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/account/export', headers: asPat })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/layout/home', headers: asPat, payload: { order: ['jobs'] } })).statusCode, 403);
  assert.equal((await post('/api/account/resume', asPat)).json().status, 'active');
  assert.equal((await post('/api/account/pause', asOwner)).statusCode, 400, 'the owner cannot be paused');

  await post(`/api/admin/users/${pat}/pause`, asOwner);
  const resume = await post('/api/account/resume', asPat);
  assert.deepEqual([resume.statusCode, resume.json().error], [403, 'The owner paused your account, so only they can resume it.']);
  assert.equal((await post('/api/account/delete', asPat, { confirmEmail: 'pat@example.com' })).statusCode, 200, 'a paused account may still delete itself');
  assert.equal(store.raw.prepare('SELECT COUNT(*) FROM users WHERE id = ?').pluck().get(pat), 0);
  await done();
});
