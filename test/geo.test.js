// US-only access (server/geo.ts): requests from outside the allowed countries get the 403 page; the health check and
// private addresses always pass; no GEO_ALLOW or no database means nothing is blocked. A fake country lookup; no download,
// no network. Requests arrive from Caddy with the visitor's address forwarded, using production's TRUST_PROXY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openJobStore } from '../db/index.ts';
import { buildApp } from '../server/app.ts';
import { countryLookup, geoAllowFromEnv, geoBlocker, isPrivateAddress, parseRelayRanges, relayLookup, shortAddress } from '../server/geo.ts';

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
  // Production: the app is US-only; the demo (made-up data, read-only) is open from any country.
  const block = (service) => compose.split(/^  (?=[a-z]+:)/m).find((b) => b.startsWith(`${service}:`)) ?? '';
  assert.match(block('app'), /GEO_ALLOW: US\b/, 'the app is US-only');
  assert.match(block('demo'), /GEO_ALLOW: ""/, 'the demo is open from any country');
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

// A made-up relay list in Apple's format, on documentation addresses only (192.0.2.0/24, 2001:db8::/32).
const RELAY_CSV = [
  '192.0.2.0/28,US,US-NY,New York,',
  '192.0.2.16/28,US,US-NY,New York,', // joins the one before
  '192.0.2.64/27,GB,GB-EN,London,',
  '2001:db8:1::/48,US,US-CA,Los Angeles,',
  '2001:db8:2:3::/64,GB,GB-EN,London,',
  '',
  'ip_prefix,country,region,city,',
  'not-an-address/24,US,,,',
  '192.0.2.200/33,US,,,',
  '2001:db8:9::/65,US,,,',
  '192.0.2.128/28,,,,',
  '192.0.2.144/28,USA,,,',
  '192.0.2.160',
].join('\n');

test('the relay list: ranges, edges, IPv6, and malformed lines skipped', () => {
  const ranges = parseRelayRanges(RELAY_CSV);
  assert.equal(ranges.v4.length, 2, 'two US /28s join; the GB /27 stays apart; bad lines are skipped');
  assert.equal(ranges.v6.length, 2, 'the /65 is skipped');
  const relay = relayLookup(ranges);
  assert.equal(relay('192.0.2.0'), 'US', 'first address');
  assert.equal(relay('192.0.2.31'), 'US', 'last address of the joined range');
  assert.equal(relay('192.0.2.32'), null, 'one past the end');
  assert.equal(relay('192.0.2.63'), null, 'one before the next range');
  assert.equal(relay('192.0.2.64'), 'GB');
  assert.equal(relay('192.0.2.95'), 'GB');
  assert.equal(relay('192.0.2.96'), null);
  assert.equal(relay('::ffff:192.0.2.5'), 'US', 'IPv4 written as IPv6');
  assert.equal(relay('192.0.2.130'), null, 'a line with no country');
  assert.equal(relay('2001:db8:1::'), 'US', 'first IPv6 address');
  assert.equal(relay('2001:db8:1:ffff:ffff:ffff:ffff:ffff'), 'US', 'last IPv6 address');
  assert.equal(relay('2001:db8:2::1'), null, 'next /48');
  assert.equal(relay('2001:db8:2:3:abcd::1'), 'GB', 'inside the /64');
  assert.equal(relay('2001:db8:2:4::1'), null, 'the next /64');
  assert.equal(relay('2001:db8:9::1'), null, 'the skipped /65');
  for (const bad of ['', 'nonsense', null, '192.0.2']) assert.equal(relay(bad), null);
  assert.deepEqual(parseRelayRanges(''), { v4: [], v6: [] });
});

test('the country check: the relay list first, DB-IP for addresses it does not list', () => {
  const relay = relayLookup(parseRelayRanges(RELAY_CSV));
  const dbip = (ip) => ({ '192.0.2.1': 'GB', '192.0.2.70': 'US', '81.2.69.142': 'GB', '8.8.8.8': 'US' })[ip] ?? null;
  const country = countryLookup({ relay, dbip });
  assert.equal(country('192.0.2.1'), 'US', 'listed as US, DB-IP says GB');
  assert.equal(country('192.0.2.70'), 'GB', 'listed as GB, DB-IP says US');
  assert.equal(country('81.2.69.142'), 'GB', 'not listed: DB-IP');
  assert.equal(country('203.0.113.9'), null, 'in neither');
  assert.equal(countryLookup({ dbip })('192.0.2.1'), 'GB', 'no relay list: DB-IP alone');
});

test('the image downloads the relay list without ever failing the build', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const step = dockerfile.split(/\nRUN /).find((s) => s.includes('mask-api.icloud.com/egress-ip-ranges.csv')) ?? '';
  assert.ok(step, 'the relay list is downloaded');
  assert.match(step, /-o \/geo\/relay\.csv/);
  assert.match(step, /; true\s*$/m, 'a failed download never fails the build');
});

async function appFrom(ip, { allow = ['US'], lookup: countryOf = lookup } = {}) {
  const store = openJobStore(':memory:');
  const app = await buildApp({ store, config: { search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null }, trustProxy: TRUST_PROXY, geo: { allow, lookup: countryOf } });
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

test('iCloud Private Relay: the country Apple lists decides, whatever DB-IP says', async () => {
  const relay = relayLookup(parseRelayRanges(RELAY_CSV));
  const dbip = (ip) => ({ '192.0.2.1': 'GB', '192.0.2.70': 'US', '81.2.69.142': 'GB', '8.8.8.8': 'US' })[ip] ?? null;
  const viaRelay = (ip) => appFrom(ip, { lookup: countryLookup({ relay, dbip }) });
  assert.equal((await (await viaRelay('192.0.2.1'))('/api/postings')).statusCode, 200, 'DB-IP says GB, Apple lists US');
  assert.equal((await (await viaRelay('192.0.2.5'))('/api/postings')).statusCode, 200, 'DB-IP has no country, Apple lists US');
  assert.equal((await (await viaRelay('2001:db8:1::7'))('/api/postings')).statusCode, 200, 'IPv6 relay address listed as US');
  assert.equal((await (await viaRelay('192.0.2.70'))('/api/postings')).statusCode, 403, 'Apple lists GB');
  assert.equal((await (await viaRelay('2001:db8:2:3::1'))('/api/postings')).statusCode, 403, 'IPv6 relay address listed as GB');
  // Not in the list: exactly as before.
  assert.equal((await (await viaRelay('81.2.69.142'))('/api/postings')).statusCode, 403);
  assert.equal((await (await viaRelay('8.8.8.8'))('/api/postings')).statusCode, 200);
  assert.equal((await (await viaRelay('203.0.113.9'))('/api/postings')).statusCode, 200, 'unknown still passes');
});
