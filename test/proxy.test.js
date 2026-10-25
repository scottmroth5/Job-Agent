// The server's TRUST_PROXY (deploy/compose.yml): behind Caddy the app must see each visitor's own address, or the
// per-address rate limits are shared by everyone and one bot can lock the owner out. Synthetic addresses only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';

const compose = readFileSync(new URL('../deploy/compose.yml', import.meta.url), 'utf8');
const values = [...compose.matchAll(/TRUST_PROXY: (\S+)/g)].map((m) => m[1]);
const CADDY = '172.18.0.4'; // Caddy's address on the Docker network

test('compose.yml trusts private proxy addresses for both containers, never a hop count', () => {
  assert.equal(values.length, 2, 'the app and the demo');
  for (const v of values) {
    assert.ok(!/^"?\d+"?$/.test(v), `TRUST_PROXY ${v} is a hop count: Fastify would report Caddy as every visitor`);
    assert.equal(v, 'loopback,linklocal,uniquelocal');
  }
});

test('with the production setting, req.ip is the visitor, and rate limits count each visitor separately', async () => {
  const store = openJobStore(':memory:');
  const app = await buildApp({
    store,
    config: { search: { homeLocations: [] }, fractional: {} },
    services: { createBrowser: async () => null },
    authMode: 'google',
    auth: {
      settings: authSettings({
        AUTH_MODE: 'google',
        PUBLIC_URL: 'https://jobs.example.com',
        GOOGLE_WEB_CLIENT_ID: 'client.apps.example',
        GOOGLE_WEB_CLIENT_SECRET: 'secret',
        AUTH_ALLOWED_EMAILS: 'pat@example.com',
        SESSION_SECRET: randomBytes(48).toString('base64'),
      }),
      exchange: async () => ({}),
    },
    trustProxy: values[0],
  });
  const via = (visitor, url = '/auth/login') => app.inject({ url, remoteAddress: CADDY, headers: { 'x-forwarded-for': visitor } });

  // A bot uses up its own sign-in allowance...
  for (let i = 0; i < 30; i += 1) await via('198.51.100.20');
  assert.equal((await via('198.51.100.20')).statusCode, 429);
  // ...and the owner, on another address, can still sign in.
  assert.notEqual((await via('203.0.113.7')).statusCode, 429);
  await app.close();
  store.close();
});
