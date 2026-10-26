// US-only access (server/geo.js): requests from outside the allowed countries get the 403 page; the health check and
// private addresses always pass; no GEO_ALLOW or no database means nothing is blocked. A fake country lookup; no download,
// no network. Requests arrive from Caddy with the visitor's address forwarded, using production's TRUST_PROXY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { geoAllowFromEnv, geoBlocker, isPrivateAddress, shortAddress } from '../server/geo.js';

const COUNTRY = { '8.8.8.8': 'US', '81.2.69.142': 'GB', '203.0.113.9': null };
const lookup = (ip) => COUNTRY[ip] ?? null;
const TRUST_PROXY = /TRUST_PROXY: (\S+)/.exec(readFileSync(new URL('../deploy/compose.yml', import.meta.url), 'utf8'))[1];
const compose = readFileSync(new URL('../deploy/compose.yml', import.meta.url), 'utf8');

test('settings and private addresses', () => {
  assert.deepEqual(geoAllowFromEnv({ GEO_ALLOW: 'us, ca ,x' }), ['US', 'CA']);
  assert.deepEqual(geoAllowFromEnv({}), []);
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.9', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '81.2.69.142', '2001:4860::8888']) assert.equal(isPrivateAddress(ip), false, ip);
  assert.equal(geoBlocker({ allow: [], lookup })({ ip: '81.2.69.142', url: '/' }), false, 'no allow list: off');
  assert.equal(geoBlocker({ allow: ['US'], lookup: null })({ ip: '81.2.69.142', url: '/' }), false, 'no database: fails open');
  assert.equal([...compose.matchAll(/GEO_ALLOW: US/g)].length, 2, 'the app and the demo are US-only in production');
});

test('refusals are logged with the country and half the address, at most hourly per address', () => {
  const warnings = [];
  let clock = 0;
  const blocked = geoBlocker({ allow: ['US'], lookup, log: { warn: (m) => warnings.push(m) }, now: () => clock });
  assert.equal(blocked({ ip: '81.2.69.142', url: '/' }), true);
  assert.equal(blocked({ ip: '81.2.69.142', url: '/other' }), true);
  clock = 3_600_001;
  blocked({ ip: '81.2.69.142', url: '/' });
  assert.deepEqual(warnings, ['[geo] refused GB 81.2.69.x', '[geo] refused GB 81.2.69.x']);
  assert.ok(!warnings.join(' ').includes('81.2.69.142'), 'never the full address');
  assert.equal(blocked({ ip: '8.8.8.8', url: '/' }), false);
  assert.equal(shortAddress('2001:db8:1234:5678::1'), '2001:db8:1234::');
});

async function appFrom(ip, { allow = ['US'] } = {}) {
  const store = openJobStore(':memory:');
  const app = await buildApp({ store, config: { search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null }, trustProxy: TRUST_PROXY, geo: { allow, lookup } });
  return (url, opts = {}) => app.inject({ url, remoteAddress: '172.18.0.4', ...opts, headers: { 'x-forwarded-for': ip, ...(opts.headers ?? {}) } });
}

test('outside the US: the 403 page on pages, the API, and sign-in; the health check still passes', async () => {
  const uk = await appFrom('81.2.69.142');
  for (const url of ['/', '/api/postings', '/api/summary', '/auth/login', '/assets/x.js']) {
    const res = await uk(url);
    assert.equal(res.statusCode, 403, url);
    assert.match(res.body, /available in the United States only/);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  assert.equal((await uk('/healthz')).statusCode, 200, 'the deploy and Docker health check');
  const unknown = await appFrom('203.0.113.9');
  assert.equal((await unknown('/api/postings')).statusCode, 200, 'an address the database does not know passes (iPhones on iCloud Private Relay)');
});

test('in the US, from inside the server, or with blocking off: everything as usual', async () => {
  assert.equal((await (await appFrom('8.8.8.8'))('/api/postings')).statusCode, 200);
  assert.equal((await (await appFrom('172.18.0.1'))('/api/postings')).statusCode, 200, "Docker's network (Caddy)");
  assert.equal((await (await appFrom('81.2.69.142', { allow: [] }))('/api/postings')).statusCode, 200, 'GEO_ALLOW unset');
});
