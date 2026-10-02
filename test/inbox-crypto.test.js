import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encrypt, decrypt, loadKey, newKey } from '../agents/inbox/crypto.js';
import { setEnvValues, hasEnvValue } from '../tools/env-file.js';

test('encrypt and decrypt round trip, with a fresh IV each time', () => {
  const key = loadKey({ EMAIL_ENC_KEY: newKey() });
  const body = 'Hello Pat,\nThanks for applying to Example Co. ünïcode ✓';
  const a = encrypt(body, key);
  const b = encrypt(body, key);
  assert.notEqual(a, b);
  assert.match(a, /^v1:/);
  assert.ok(!a.includes('Example'));
  assert.equal(decrypt(a, key), body);
});

test('a tampered value or a wrong key is rejected', () => {
  const key = loadKey({ EMAIL_ENC_KEY: newKey() });
  const stored = encrypt('secret body', key);
  const parts = stored.split(':');
  const data = Buffer.from(parts[3], 'base64');
  data[0] ^= 1;
  parts[3] = data.toString('base64');
  assert.throws(() => decrypt(parts.join(':'), key));
  assert.throws(() => decrypt(stored, loadKey({ EMAIL_ENC_KEY: newKey() })));
  assert.throws(() => decrypt('plain text', key), /Not an encrypted/);
});

test('loadKey accepts base64 or hex 32-byte keys and never echoes a bad one', () => {
  assert.equal(loadKey({ EMAIL_ENC_KEY: 'ab'.repeat(32) }).length, 32);
  assert.throws(() => loadKey({}), /not set/);
  const bad = 'c2hvcnQ=';
  assert.throws(
    () => loadKey({ EMAIL_ENC_KEY: bad }),
    (err) => /32 bytes/.test(err.message) && !err.message.includes(bad),
  );
});

test('setEnvValues replaces or appends lines and keeps the rest', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'env-')), '.env');
  writeFileSync(path, 'ANTHROPIC_API_KEY=x\nGMAIL_REFRESH_TOKEN=old\n');
  assert.deepEqual(setEnvValues({ GMAIL_REFRESH_TOKEN: 'new', EMAIL_ENC_KEY: 'k' }, path), ['GMAIL_REFRESH_TOKEN', 'EMAIL_ENC_KEY']);
  assert.equal(readFileSync(path, 'utf8'), 'ANTHROPIC_API_KEY=x\nGMAIL_REFRESH_TOKEN=new\nEMAIL_ENC_KEY=k\n');
  assert.ok(hasEnvValue('EMAIL_ENC_KEY', path));
  assert.ok(!hasEnvValue('MISSING', path));
  assert.throws(() => setEnvValues({ BAD: 'a\nb' }, path), /line break/);
  assert.throws(() => setEnvValues({ 'bad-key': 'a' }, path), /Invalid/);
});
