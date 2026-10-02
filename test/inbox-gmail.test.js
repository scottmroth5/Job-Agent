import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import { createGmail, normalizeMessage, labelName, parseFrom, isQuotaError } from '../agents/inbox/gmail.js';
import { newMessageIds, backfillMessageIds, saveCursor, CURSOR_KEY } from '../agents/inbox/sync.js';
import { fakeGmailApi, message } from './fixtures/inbox/fake-gmail.js';

const msgs = [
  message({ id: 'm1', from: 'Example Recruiting <no-reply@us.greenhouse.io>', subject: 'Thank you for applying to Example Co', body: 'Thanks!' }),
  message({ id: 'm2', from: 'news@newsletter.example', subject: 'Weekly digest', body: '<p>Hello</p>', html: true }),
];

test('messages are normalized: sender, domain, subject, date, and body', () => {
  const m = normalizeMessage(msgs[0]);
  assert.deepEqual([m.senderName, m.senderEmail, m.senderDomain, m.subject, m.sentAt, m.rawBody, m.bodyIsHtml], [
    'Example Recruiting', 'no-reply@us.greenhouse.io', 'us.greenhouse.io', 'Thank you for applying to Example Co', '2026-10-01T15:00:00.000Z', 'Thanks!', false,
  ]);
  assert.equal(normalizeMessage(msgs[1]).bodyIsHtml, true);
  assert.deepEqual(parseFrom('plain@example.com'), { name: null, email: 'plain@example.com' });
});

test('the wrapper offers only read and add-label operations', () => {
  const g = createGmail({ api: fakeGmailApi().api });
  assert.deepEqual(Object.keys(g).sort(), ['addThreadLabel', 'ensureLabel', 'getMessage', 'historySince', 'listMessages', 'profile', 'sentThreadIds']);
  for (const k of Object.keys(g)) assert.doesNotMatch(k, /send|delete|trash|archive|remove/i);
});

test('labels: Job/<Company> is sanitized, created once, and only ever added', async () => {
  assert.equal(labelName('Example / Sample Co'), 'Job/Example Sample Co');
  assert.equal(labelName(''), 'Job/Unknown');
  const { api, calls } = fakeGmailApi();
  const g = createGmail({ api });
  const a = await g.ensureLabel('Job/Example Co');
  assert.equal(await g.ensureLabel('Job/Example Co'), a);
  await g.addThreadLabel('t1', a);
  assert.equal(calls.filter((c) => c.name === 'labels.create').length, 1);
  const modify = calls.find((c) => c.name === 'threads.modify');
  assert.deepEqual(modify.args.requestBody, { addLabelIds: [a] });
});

test('sentThreadIds lists the threads I sent in with one list call, not one lookup per thread', async () => {
  const mine = message({ id: 'm9', threadId: 'tA', from: 'me@example.net', subject: 'Following up', labelIds: ['SENT'] });
  const { api, calls } = fakeGmailApi({ messages: [...msgs, mine] });
  const sent = await createGmail({ api }).sentThreadIds(180);
  assert.deepEqual([...sent], ['tA']);
  assert.equal(calls.find((c) => c.name === 'messages.list').args.q, 'in:sent newer_than:180d');
  assert.equal(calls.filter((c) => c.name === 'threads.get').length, 0);
});

test('quota errors are retried after a wait; other errors and exhausted retries are thrown', async () => {
  const quota = Object.assign(new Error("Quota exceeded for quota metric 'Total Query Cost'"), { code: 429 });
  assert.ok(isQuotaError(quota));
  assert.ok(isQuotaError(Object.assign(new Error('x'), { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] })));
  assert.ok(!isQuotaError(Object.assign(new Error('Forbidden'), { code: 403, errors: [{ reason: 'insufficientPermissions' }] })));

  const { api } = fakeGmailApi({ messages: msgs });
  let failures = 2;
  const realGet = api.users.messages.get;
  api.users.messages.get = async (a) => (failures-- > 0 ? Promise.reject(quota) : realGet(a));
  const waited = [];
  const g = createGmail({ api, waits: [5, 10, 20], sleep: async () => {}, onWait: (ms) => waited.push(ms) });
  assert.equal((await g.getMessage('m1')).gmailMessageId, 'm1');
  assert.deepEqual(waited, [5, 10]);

  failures = 10;
  await assert.rejects(g.getMessage('m1'), /Quota exceeded/);
  api.users.messages.get = async () => Promise.reject(Object.assign(new Error('Not found'), { code: 404 }));
  waited.length = 0;
  await assert.rejects(g.getMessage('m1'), /Not found/);
  assert.deepEqual(waited, [], 'no retry for other errors');
});

test('history mode returns messages since the stored historyId and the next cursor', async () => {
  const store = openJobStore(':memory:');
  setSetting(store.db, CURSOR_KEY, '100');
  const { api } = fakeGmailApi({ messages: msgs, history: { 100: ['m1', 'm1', 'm2'] }, historyId: '150' });
  const r = await newMessageIds({ gmail: createGmail({ api }), db: store.db });
  assert.deepEqual(r, { messageIds: ['m1', 'm2'], nextHistoryId: '150', mode: 'history' });
  assert.equal(getSetting(store.db, CURSOR_KEY), '100', 'not saved until processing finishes');
  saveCursor(store.db, r.nextHistoryId);
  assert.equal(getSetting(store.db, CURSOR_KEY), '150');
  store.close();
});

test('an expired historyId falls back to a 7-day search and resets the cursor', async () => {
  const store = openJobStore(':memory:');
  setSetting(store.db, CURSOR_KEY, '1');
  const { api, calls } = fakeGmailApi({ messages: msgs, expiredHistory: true, historyId: '777' });
  const r = await newMessageIds({ gmail: createGmail({ api }), db: store.db, fallbackDays: 7 });
  assert.deepEqual([r.mode, r.nextHistoryId, r.messageIds.length], ['fallback', '777', 2]);
  assert.equal(calls.find((c) => c.name === 'messages.list').args.q, 'newer_than:7d -in:chats');
  store.close();
});

test('the first run reads the fallback window; backfill reads the configured window', async () => {
  const store = openJobStore(':memory:');
  const { api, calls } = fakeGmailApi({ messages: msgs });
  assert.equal((await newMessageIds({ gmail: createGmail({ api }), db: store.db })).mode, 'initial');
  const b = await backfillMessageIds({ gmail: createGmail({ api }), days: 180 });
  assert.equal(b.mode, 'backfill');
  assert.equal(calls.filter((c) => c.name === 'messages.list').at(-1).args.q, 'newer_than:180d -in:chats');
  store.close();
});

test('errors other than an expired history are not swallowed', async () => {
  const store = openJobStore(':memory:');
  setSetting(store.db, CURSOR_KEY, '1');
  const { api } = fakeGmailApi();
  api.users.history.list = async () => {
    throw Object.assign(new Error('Server error'), { code: 500 });
  };
  await assert.rejects(newMessageIds({ gmail: createGmail({ api }), db: store.db }), /Server error/);
  store.close();
});
