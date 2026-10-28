// About you in the app for everyone, the owner included (agents/user-config.js backgroundFor, server/account-routes.js):
// the owner's Google Doc is read only until they move their text into the app; a document can fill the box for review.
// Synthetic data; the Google Doc is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Document, Packer, Paragraph } from 'docx';
import { openJobStore } from '../db/index.js';
import { addUser, OWNER_ID } from '../db/users.js';
import { backgroundFor, saveUserProfile, userProfile } from '../agents/user-config.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.js';

const SITE = 'http://localhost:5178';
const LONG = (who) => `${who} background. `.repeat(40);

test('backgroundFor: About you when long enough; the owner falls back to the Doc; anyone else is told to add it', async () => {
  const store = openJobStore(':memory:');
  const raw = store.raw;
  const b = addUser(raw, { email: 'b@example.com' });
  let reads = 0;
  const googleDoc = async () => {
    reads += 1;
    return 'the Google Doc';
  };
  assert.equal(await backgroundFor(raw, OWNER_ID, { googleDoc }), 'the Google Doc');
  saveUserProfile(raw, OWNER_ID, LONG('Owner'));
  assert.equal(await backgroundFor(raw, OWNER_ID, { googleDoc }), LONG('Owner').trim());
  assert.equal(reads, 1, 'the Doc is not read once About you is in the app');
  saveUserProfile(raw, OWNER_ID, 'too short');
  assert.equal(await backgroundFor(raw, OWNER_ID, { googleDoc }), 'the Google Doc', 'a short About you falls back again');
  await assert.rejects(backgroundFor(raw, b, { googleDoc }), /Settings/, "another user never gets the owner's Doc");
  store.close();
});

async function setup() {
  const before = process.env.YOUR_KNOWLEDGE_DOC_ID;
  process.env.YOUR_KNOWLEDGE_DOC_ID = 'doc-id-example';
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  const b = addUser(store.raw, { email: 'b@example.com', name: 'Sam' });
  const app = await buildApp({
    store,
    config: { candidate: { name: 'O' }, search: { homeLocations: [] }, fractional: {} },
    authMode: 'google',
    auth: { settings },
    services: { createBrowser: async () => null, knowledge: async () => LONG('Doc'), log: { info() {}, warn() {}, error() {} } },
  });
  const as = (email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE });
  const done = async () => {
    await app.close();
    store.close();
    if (before === undefined) delete process.env.YOUR_KNOWLEDGE_DOC_ID;
    else process.env.YOUR_KNOWLEDGE_DOC_ID = before;
  };
  return { store, app, b, owner: as('owner@example.com'), other: as('b@example.com'), done };
}

test('the owner copies their Google Doc into About you once; nobody else can', async () => {
  const { store, app, b, owner, other, done } = await setup();
  let s = (await app.inject({ url: '/api/account/search', headers: owner })).json();
  assert.equal(s.aboutYouFrom, 'google');
  const copied = await app.inject({ method: 'POST', url: '/api/account/profile/from-google-doc', headers: owner });
  assert.equal(copied.statusCode, 200);
  assert.equal(copied.json().aboutYouFrom, 'app');
  assert.equal(userProfile(store.raw, OWNER_ID), LONG('Doc').trim());
  assert.equal((await app.inject({ method: 'POST', url: '/api/account/profile/from-google-doc', headers: other })).statusCode, 400);
  assert.equal(userProfile(store.raw, b), '', "the owner's Doc never reaches another user");
  s = (await app.inject({ method: 'PUT', url: '/api/account/profile', headers: owner, payload: { text: LONG('Edited') } })).json();
  assert.equal(s.profile, LONG('Edited').trim(), 'the owner saves edits here');
  await done();
});

test('Fill from a document returns the text and saves nothing; bad files say what to upload', async () => {
  const { store, app, b, other, done } = await setup();
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: ['Sam Example', 'Head of Data at Example Co, 2021 to now, team of 12.'].map((t) => new Paragraph(t)) }] }));
  const upload = (body, name) => app.inject({ method: 'POST', url: '/api/account/profile/from-file', headers: { ...other, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, payload: body });
  const res = await upload(docx, 'My resume.docx');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { kind: 'docx', text: 'Sam Example\n\nHead of Data at Example Co, 2021 to now, team of 12.' });
  assert.equal(userProfile(store.raw, b), '', 'nothing saved until Save');
  const refused = await upload(Buffer.from('x'.repeat(100)), 'old.doc');
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /\.docx or PDF/);
  await done();
});
