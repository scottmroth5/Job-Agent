// The support address (SUPPORT_EMAIL): shown where people look for help when it is set, and a fallback when not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { page } from '../server/auth.js';
import { loadGuides } from '../server/help-routes.js';
import { supportEmail, withSupport } from '../tools/support.js';

test('the address: a plain address or nothing; the placeholder becomes a link or the fallback', () => {
  assert.equal(supportEmail({ SUPPORT_EMAIL: ' support@example.com ' }), 'support@example.com');
  for (const bad of ['', 'not an address', 'a@b.com, c@d.com', '"x"@example.com', 'x@example.com\r\nBcc: y@example.com']) assert.equal(supportEmail({ SUPPORT_EMAIL: bad }), null, bad);
  assert.equal(withSupport('Ask: {{supportContact}}.', 'support@example.com'), 'Ask: email [support@example.com](mailto:support@example.com).');
  assert.equal(withSupport('Ask: {{supportContact}}.', null), 'Ask: contact the person who runs this app.');
});

test('with SUPPORT_EMAIL set: the policy, terms, Help, sign-in pages, and /api/me show it', async () => {
  const before = process.env.SUPPORT_EMAIL;
  process.env.SUPPORT_EMAIL = 'support@example.com';
  try {
    const store = openJobStore(':memory:');
    const app = await buildApp({ store, config: { candidate: { name: 'O' }, search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null } });
    for (const path of ['/privacy', '/terms']) assert.match((await app.inject(path)).body, /<a href="mailto:support@example\.com"[^>]*>support@example\.com<\/a>/, path);
    assert.equal((await app.inject('/api/me')).json().supportEmail, 'support@example.com');
    assert.match(loadGuides().find((g) => g.id === 'account').markdown, /mailto:support@example\.com/);
    assert.match(page('Waiting for approval', '<p>x</p>'), /Questions\? Email <a href="mailto:support@example\.com">/);
    await app.close();
    store.close();
  } finally {
    if (before === undefined) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = before;
  }
  assert.ok(!page('Signed out', '<p>x</p>').includes('Questions?'), 'unset: no line');
  assert.ok(!loadGuides().some((g) => g.markdown.includes('{{supportContact}}')), 'never a raw placeholder');
});
