// Multi-user, phase 2: requesting access, the admin's decisions, the emails each one sends (and to whom), and each
// user's own Claude key. Made-up accounts and keys; Google, Anthropic, and email are faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openJobStore } from '../db/index.js';
import { getUser, OWNER_ID } from '../db/users.js';
import { buildApp } from '../server/app.js';
import { authSettings, MAX_PENDING } from '../server/auth.js';
import { createNotices } from '../server/notices.js';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.js';
import { boxKey, open, seal } from '../tools/secret-box.js';

const SITE = 'http://localhost:5178';
const OWNER = 'owner@example.com';
const KEY_SECRET = 'a test secret for sealing user keys, 32+ characters';

async function setup({ keyWorks = true } = {}) {
  process.env.USER_KEY_SECRET = KEY_SECRET;
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({
    AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'client.apps.example', GOOGLE_WEB_CLIENT_SECRET: 'secret',
    AUTH_ALLOWED_EMAILS: OWNER, SESSION_SECRET: secret,
  });
  const store = openJobStore(':memory:', { fallbackUid: null });
  const sent = [];
  const notices = createNotices({ send: async (email) => sent.push(email), owner: () => OWNER, appUrl: () => SITE, log: {} });
  const checked = [];
  const app = await buildApp({
    store,
    config: { search: { homeLocations: [] }, fractional: {} },
    authMode: 'google',
    auth: { settings, exchange: async () => assert.fail('no Google here') },
    services: { createBrowser: async () => null, notices, checkClaudeKey: async (k) => { checked.push(k); return keyWorks; }, log: { info() {}, warn() {}, error() {} } },
  });
  const as = (email) => `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`;
  const form = (cookie, body) => app.inject({ method: 'POST', url: '/auth/register', headers: { cookie, origin: SITE, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(body).toString() });
  return { store, app, sent, checked, as, form, done: async () => { await app.close(); store.close(); } };
}

test('a new address is sent to request access; the request makes a pending account and emails the owner only', async () => {
  const { store, app, sent, as, form, done } = await setup();
  const pat = as('Pat@Example.com'.toLowerCase());
  const page = await app.inject({ url: '/', headers: { cookie: pat } });
  assert.deepEqual([page.statusCode, page.headers.location], [302, '/auth/register']);
  const api = await app.inject({ url: '/api/postings', headers: { cookie: pat } });
  assert.deepEqual([api.statusCode, api.json().account], [403, 'none']);
  const form1 = await app.inject({ url: '/auth/register', headers: { cookie: pat } });
  assert.match(form1.body, /Request access/);
  assert.match(form1.body, /href="\/terms"/);
  assert.ok(!/<script/i.test(form1.body), 'no script: the CSP allows none inline');

  assert.equal((await form(pat, { name: 'Pat' })).statusCode, 400, 'the terms must be accepted');
  assert.equal((await form(pat, { name: '  ', terms: 'yes' })).statusCode, 400, 'a name is needed');
  const other = await app.inject({ method: 'POST', url: '/auth/register', headers: { cookie: pat, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'name=Pat&terms=yes' });
  assert.equal(other.statusCode, 403, 'only from this site');
  const ok = await form(pat, { name: 'Pat <b>Example</b>', note: 'Former colleague', terms: 'yes' });
  assert.deepEqual([ok.statusCode, ok.headers.location], [303, '/auth/waiting']);
  const row = store.raw.prepare("SELECT * FROM users WHERE email = 'pat@example.com'").get();
  assert.deepEqual([row.status, row.role, row.ai_source, Boolean(row.terms_accepted_at)], ['pending', 'user', 'own', true]);
  assert.equal(sent.length, 1, JSON.stringify(sent.map((e) => [e.to, e.subject])));
  assert.equal(sent[0].to, OWNER, 'the request goes to the owner');
  assert.match(sent[0].text, /#\/admin\/users/);
  assert.ok(!sent[0].text.includes('Former colleague'), 'the note stays in the app');

  // Asking again changes nothing and sends nothing; the pending address waits.
  await form(pat, { name: 'Pat', terms: 'yes' });
  assert.equal(sent.length, 1, JSON.stringify(sent.map((e) => [e.to, e.subject])));
  assert.deepEqual([(await app.inject({ url: '/', headers: { cookie: pat } })).headers.location], ['/auth/waiting']);
  assert.match((await app.inject({ url: '/auth/waiting', headers: { cookie: pat } })).body, /waiting|with the owner/i);
  assert.equal((await app.inject({ url: '/auth/register', headers: { cookie: pat } })).headers.location, '/auth/waiting');
  // A post from an address that already has an account goes nowhere (an earlier bug made an account with no address).
  assert.deepEqual(store.raw.prepare('SELECT email FROM users WHERE id != ? ORDER BY id').pluck().all(OWNER_ID), ['pat@example.com']);
  assert.equal((await form('ja_session=forged.AAAA', { name: 'X', terms: 'yes' })).headers.location, '/auth/login', 'no session, no request');
  assert.equal(store.raw.prepare('SELECT COUNT(*) FROM users').pluck().get(), 2);
  // The name is shown escaped wherever it appears.
  const list = (await app.inject({ url: '/api/admin/users', headers: { cookie: as(OWNER) } })).json();
  assert.equal(list.find((u) => u.email === 'pat@example.com').name, 'Pat <b>Example</b>');
  await done();
});

test('the owner approves, pauses, resumes, and rejects; each person is emailed about their own account only', async () => {
  const { store, app, sent, as, form, done } = await setup();
  const owner = as(OWNER);
  await form(as('pat@example.com'), { name: 'Pat', terms: 'yes' });
  await form(as('sam@example.com'), { name: 'Sam', terms: 'yes' });
  const ids = Object.fromEntries(store.raw.prepare('SELECT email, id FROM users').all().map((u) => [u.email, u.id]));
  const act = (id, decision, cookie = owner) => app.inject({ method: 'POST', url: `/api/admin/users/${id}/${decision}`, headers: { cookie, origin: SITE } });

  assert.equal((await act(ids['pat@example.com'], 'approve', as('sam@example.com'))).statusCode, 403, 'a pending account cannot');
  assert.equal((await act(ids['pat@example.com'], 'approve')).json().status, 'active');
  assert.deepEqual([sent.at(-1).to, sent.at(-1).subject], ['pat@example.com', 'Job Hunt: your access is approved']);
  const pat = as('pat@example.com');
  assert.equal((await app.inject({ url: '/api/postings', headers: { cookie: pat } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/admin/users', headers: { cookie: pat } })).statusCode, 403, 'a user is not an admin');
  assert.equal((await act(ids['sam@example.com'], 'approve', pat)).statusCode, 403);

  assert.equal((await act(ids['sam@example.com'], 'reject')).json().status, 'rejected');
  assert.equal(sent.at(-1).to, 'sam@example.com');
  assert.equal((await app.inject({ url: '/', headers: { cookie: as('sam@example.com') } })).headers.location, '/auth/not-approved');
  assert.equal((await act(ids['sam@example.com'], 'pause')).statusCode, 400, 'only an active account can be paused');

  assert.equal((await act(ids['pat@example.com'], 'pause')).json().status, 'paused');
  assert.equal(sent.at(-1).to, 'pat@example.com');
  assert.equal((await act(ids['pat@example.com'], 'resume')).json().status, 'active');
  assert.equal((await act(OWNER_ID, 'pause')).statusCode, 404, 'the owner cannot be paused');
  assert.equal((await act(999, 'approve')).statusCode, 404);
  assert.equal((await act(ids['pat@example.com'], 'delete')).statusCode, 400);

  // Every email went to the owner or to the person it was about.
  for (const e of sent) assert.ok([OWNER, 'pat@example.com', 'sam@example.com'].includes(e.to), e.to);

  // AI access: their own key, or the owner's key with a cap.
  const ai = (body) => app.inject({ method: 'PUT', url: `/api/admin/users/${ids['pat@example.com']}/ai`, headers: { cookie: owner, origin: SITE }, payload: body });
  assert.deepEqual([(await ai({ source: 'owner', capUsd: 10 })).json().ai_source, getUser(store.raw, ids['pat@example.com']).ai_cap_usd], ['owner', 10]);
  assert.equal((await ai({ source: 'owner' })).statusCode, 400, 'a cap is needed');
  assert.equal((await ai({ source: 'own' })).json().ai_cap_usd, null);
  await done();
});

test('Settings: a user saves their own key (checked, sealed, never returned) and removes it; the owner cannot', async () => {
  const { store, app, checked, as, form, done } = await setup();
  await form(as('pat@example.com'), { name: 'Pat', terms: 'yes' });
  const id = store.raw.prepare("SELECT id FROM users WHERE email = 'pat@example.com'").pluck().get();
  store.raw.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(id);
  const pat = as('pat@example.com');
  const put = (key, cookie = pat) => app.inject({ method: 'PUT', url: '/api/account/claude-key', headers: { cookie, origin: SITE }, payload: { key } });
  const madeUp = 'sk-ant-api03-made-up-key-for-tests-0123456789';

  assert.equal((await put('not a key')).statusCode, 400);
  assert.deepEqual(checked, [], 'a malformed key is not sent to Anthropic');
  const saved = await put(madeUp);
  assert.equal(saved.statusCode, 200);
  assert.deepEqual([saved.json().ai.keySet, saved.json().ai.paidBy], [true, 'own']);
  assert.ok(!saved.body.includes(madeUp), 'the key is never sent back');
  const sealed = store.raw.prepare('SELECT claude_key_enc FROM users WHERE id = ?').pluck().get(id);
  assert.ok(!sealed.includes(madeUp) && sealed.startsWith('v1.'));
  assert.equal(open(sealed, id, boxKey(KEY_SECRET)), madeUp);
  assert.throws(() => open(sealed, id + 1, boxKey(KEY_SECRET)), 'bound to its user');
  for (const url of ['/api/account', '/api/me', '/api/admin/users']) {
    const body = (await app.inject({ url, headers: { cookie: url.includes('admin') ? as(OWNER) : pat } })).body;
    assert.ok(!body.includes(madeUp) && !body.includes(sealed), `${url} shows neither the key nor its sealed form`);
  }
  assert.equal((await put(madeUp, as(OWNER))).statusCode, 400, "the owner's AI uses ANTHROPIC_API_KEY");
  const removed = await app.inject({ method: 'DELETE', url: '/api/account/claude-key', headers: { cookie: pat, origin: SITE } });
  assert.equal(removed.json().ai.keySet, false);
  await done();

  const refusing = await setup({ keyWorks: false });
  await refusing.form(refusing.as('pat@example.com'), { name: 'Pat', terms: 'yes' });
  refusing.store.raw.prepare("UPDATE users SET status = 'active' WHERE email = 'pat@example.com'").run();
  const res = await refusing.app.inject({ method: 'PUT', url: '/api/account/claude-key', headers: { cookie: refusing.as('pat@example.com'), origin: SITE }, payload: { key: madeUp } });
  assert.deepEqual([res.statusCode, res.json().error], [400, 'Anthropic did not accept this key.']);
  await refusing.done();
});

test('requests close when too many are waiting; the privacy policy and terms are public', async () => {
  const { store, app, as, form, done } = await setup();
  const insert = store.raw.prepare("INSERT INTO users (email, role, status, created_at, updated_at) VALUES (?, 'user', 'pending', 'x', 'x')");
  for (let i = 0; i < MAX_PENDING; i += 1) insert.run(`waiting${i}@example.com`);
  assert.match((await app.inject({ url: '/auth/register', headers: { cookie: as('late@example.com') } })).body, /not taking new requests/);
  await form(as('late@example.com'), { name: 'Late', terms: 'yes' });
  assert.equal(store.raw.prepare("SELECT COUNT(*) FROM users WHERE email = 'late@example.com'").pluck().get(), 0);
  for (const path of ['/privacy', '/terms']) {
    const res = await app.inject(path);
    assert.equal(res.statusCode, 200, path);
    assert.match(res.headers['content-type'], /text\/html/);
  }
  await done();
});

test('the secret box: sealed per user, fresh each time, and a missing or short secret refuses', () => {
  const key = boxKey(KEY_SECRET);
  const a = seal('value', 7, key);
  assert.notEqual(a, seal('value', 7, key), 'a fresh nonce every time');
  assert.equal(open(a, 7, key), 'value');
  assert.throws(() => open(a, 8, key));
  assert.throws(() => open(a, 7, boxKey('another secret that is long enough to use here')));
  assert.throws(() => open(`${a.slice(0, -2)}AA`, 7, key), 'a changed value does not open');
  assert.throws(() => boxKey('short'), /at least 32/);
  assert.throws(() => boxKey(''), /USER_KEY_SECRET/);
});
