// Knowledge doc versions and Word downloads (agents/user-config.js saveUserProfile and profileVersions, the
// /api/account/profile routes): every save keeps the one before, an earlier version can be made current again, and any
// version downloads as Word. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { addUser, OWNER_ID } from '../db/users.js';
import { MAX_PROFILE_VERSIONS, profileVersions, saveUserProfile, userProfile } from '../agents/user-config.js';
import { documentText } from '../tools/doc-text.js';

const doc = (n) => `## 1. Summary\nEngineering leader, version ${n}.\n\n## 2. Experience\n- Grew a platform team from 6 to 45 engineers.`;

test('every save is a version, newest first; the same text again adds none; a doc saved before versions is kept', () => {
  const { raw } = openJobStore(':memory:');
  raw.prepare("INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, 'profile.text', ?, '2026-10-01T12:00:00.000Z')").run(OWNER_ID, doc(0));
  assert.deepEqual(profileVersions(raw, OWNER_ID).map((v) => [v.source, v.savedAt]), [['earlier', '2026-10-01T12:00:00.000Z']]);
  saveUserProfile(raw, OWNER_ID, doc(1), { source: 'file', now: new Date('2026-10-28T12:00:00Z') });
  saveUserProfile(raw, OWNER_ID, doc(1), { now: new Date('2026-10-28T13:00:00Z') });
  saveUserProfile(raw, OWNER_ID, doc(2), { source: 'nonsense', now: new Date('2026-10-29T12:00:00Z') });
  assert.deepEqual(profileVersions(raw, OWNER_ID).map((v) => [v.text, v.source]), [[doc(2), 'typed'], [doc(1), 'file'], [doc(0), 'earlier']]);
  for (let i = 3; i < 30; i++) saveUserProfile(raw, OWNER_ID, doc(i));
  assert.equal(profileVersions(raw, OWNER_ID).length, MAX_PROFILE_VERSIONS);
  assert.equal(userProfile(raw, OWNER_ID), doc(29));
  const b = addUser(raw, { email: 'b@example.com', name: 'Sam' });
  assert.deepEqual(profileVersions(raw, b), [], "another user's are their own");
});

test('the routes: list, view, make current, and download the current doc or a version as Word', async () => {
  const store = openJobStore(':memory:');
  const app = await buildApp({ store, config: { candidate: { name: 'Pat' }, search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null } });
  for (const [n, source] of [[1, 'file'], [2, 'typed']]) {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/account/profile', payload: { text: doc(n), source } })).statusCode, 200);
  }
  assert.equal((await app.inject({ method: 'PUT', url: '/api/account/profile', payload: { text: doc(3), source: 'bogus' } })).statusCode, 400);
  const list = (await app.inject('/api/account/profile/versions')).json();
  assert.deepEqual(list.map(({ n, current, source }) => [n, current, source]), [[2, true, 'typed'], [1, false, 'file']]);
  assert.ok(!('text' in list[0]), 'the list carries no text');
  assert.equal((await app.inject('/api/account/profile/versions/1')).json().text, doc(1));
  assert.equal((await app.inject('/api/account/profile/versions/9')).statusCode, 404);

  const word = async (url) => {
    const r = await app.inject(url);
    assert.equal(r.statusCode, 200, url);
    assert.match(r.headers['content-type'], /wordprocessingml/);
    return (await documentText(r.rawPayload, 'k.docx')).text;
  };
  assert.match(await word('/api/account/profile.docx'), /version 2/);
  assert.match((await app.inject('/api/account/profile.docx?version=1')).headers['content-disposition'], /^attachment; filename="[^"]*Knowledge Doc v1\.docx"$/);
  assert.match(await word('/api/account/profile.docx?version=1'), /version 1/);

  const restored = await app.inject({ method: 'POST', url: '/api/account/profile/versions/1/restore' });
  assert.equal(restored.json().profile, doc(1));
  assert.deepEqual((await app.inject('/api/account/profile/versions')).json().map(({ n, source }) => [n, source]), [[3, 'restore'], [2, 'typed'], [1, 'file']]);
  await app.close();
  store.close();
});
