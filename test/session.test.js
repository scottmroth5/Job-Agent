import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sessionKey, sign, verify, parseCookies, cookie } from '../server/session.js';

const key = sessionKey(randomBytes(48).toString('base64'));
const later = Date.now() + 60_000;

test('a signed session round trips; tampering, the wrong key, and expiry are rejected', () => {
  const token = sign({ email: 'pat@example.com', exp: later }, key);
  assert.deepEqual(verify(token, key), { email: 'pat@example.com', exp: later });

  const [data, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ email: 'eve@example.com', exp: later })).toString('base64url');
  assert.equal(verify(`${forged}.${sig}`, key), null, 'changed payload');
  assert.equal(verify(`${data}.${sig.slice(0, -2)}xx`, key), null, 'changed signature');
  assert.equal(verify(token, sessionKey(randomBytes(48).toString('base64'))), null, 'other secret');
  assert.equal(verify(sign({ email: 'pat@example.com', exp: Date.now() - 1 }, key), key), null, 'expired');
  for (const junk of ['', 'abc', 'a.b.c', null, undefined]) assert.equal(verify(junk, key), null);
  assert.throws(() => sign({ email: 'x' }, key), /exp is required/);
});

test('the secret must be at least 32 bytes', () => {
  assert.throws(() => sessionKey('short'), /at least 32 bytes/);
  assert.throws(() => sessionKey(undefined), /auth:setup/);
  assert.equal(sessionKey('x'.repeat(40)).length, 40);
});

test('cookies parse and serialize with safe flags', () => {
  assert.deepEqual(parseCookies('a=1; ja_session=x.y%3D; empty='), { a: '1', ja_session: 'x.y=', empty: '' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(cookie('ja_session', 'v', { maxAge: 60, secure: true }), 'ja_session=v; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60');
  assert.equal(cookie('ja_session', '', { maxAge: 0 }), 'ja_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
});
