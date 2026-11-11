// The admin's device, location, and source totals (server/usage-totals.ts, usage_totals): counted once per account per
// day for visits, per page arrival for sources, with nothing that leads back to a person. Made-up accounts, addresses
// (documentation ranges), and hosts; a fake location lookup; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.ts';
import { addUser } from '../db/users.ts';
import { USER_TABLES } from '../db/user-tables.ts';
import { deleteAccount, exportAccount } from '../agents/account-data.ts';
import { buildApp } from '../server/app.ts';
import { authSettings } from '../server/auth.ts';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.ts';
import { GOOGLE_SIGNIN_RETURN, SOURCES, browserOf, deviceOf, locationValue, sourceOf } from '../server/usage-totals.ts';
import * as usageBrowser from '../db/migrations/021-usage-browser.ts';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { DEMO_CONFIG } from '../demo/sample-data.ts';
import { fakeServices } from './fixtures/fakes.js';
/** @typedef {{ dimension: string, value: string, count: number }} Total */

const SITE = 'https://jobs.example.com';
const OWNER = 'owner@example.com';
const HOSTS = { siteHost: 'example.org', demoHost: 'demo.example.org' };
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  androidPhone: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};
// The fake location database: one known address, one it misses, one that breaks.
/** @type {Record<string, { city: string | null, state: string | null, country: string }>} */
const PLACES = { '203.0.113.7': { city: 'Springfield', state: 'Illinois', country: 'United States' } };
const location = (/** @type {string} */ ip) => {
  if (ip === '198.51.100.66') throw new Error('database read failed');
  return PLACES[ip] ?? null;
};

test('device type from the user agent and the mobile hint', () => {
  assert.equal(deviceOf({ 'user-agent': UA.iphone }), 'phone');
  assert.equal(deviceOf({ 'user-agent': UA.androidPhone }), 'phone');
  assert.equal(deviceOf({ 'user-agent': UA.ipad }), 'tablet');
  assert.equal(deviceOf({ 'user-agent': UA.androidTablet }), 'tablet');
  assert.equal(deviceOf({ 'user-agent': UA.windows }), 'computer');
  assert.equal(deviceOf({ 'user-agent': UA.windows, 'sec-ch-ua-mobile': '?1' }), 'phone');
  assert.equal(deviceOf({}), 'computer');
});

test('browser and major version: a fixed name and a number, or Other', () => {
  const b = (/** @type {string} */ ua) => browserOf({ 'user-agent': ua });
  assert.equal(b(UA.windows), 'Chrome 130');
  assert.equal(b(UA.androidPhone), 'Chrome 130');
  assert.equal(b(UA.iphone), 'Safari 18');
  assert.equal(b(UA.ipad), 'Safari 18');
  assert.equal(b('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'), 'Safari 18');
  assert.equal(b(`${UA.windows} Edg/130.0.2849.68`), 'Edge 130');
  assert.equal(b(`${UA.windows} OPR/115.0.0.0`), 'Opera 115');
  assert.equal(b('Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36'), 'Samsung Internet 27');
  assert.equal(b('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'), 'Firefox 132');
  assert.equal(b('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1'), 'Chrome 130');
  assert.equal(b('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15'), 'Firefox 132');
  // Anything else, or text made to look like a browser with extra words, never passes through.
  assert.equal(b('curl/8.5.0'), 'Other');
  assert.equal(b(''), 'Other');
  assert.equal(b('Mozilla/5.0 Chrome/<script>'), 'Other');
  assert.equal(b('Mozilla/5.0 Chrome/99999999'), 'Chrome 999');
  for (const ua of Object.values(UA)) assert.match(b(ua), /^(?:(?:Edge|Opera|Samsung Internet|Firefox|Chrome|Safari) \d{1,3}|Other)$/);
});

test('migration 021 adds the browser dimension and keeps the totals already counted', () => {
  const db = new Database(':memory:');
  db.exec(readFileSync('db/migrations/020-usage-totals.sql', 'utf8'));
  db.prepare("INSERT INTO usage_totals VALUES ('2026-11-02', 'device', 'phone', 3), ('2026-11-02', 'source', 'linkedin', 2)").run();
  assert.throws(() => db.prepare("INSERT INTO usage_totals VALUES ('2026-11-02', 'browser', 'Chrome 130', 1)").run());
  usageBrowser.up(db);
  db.prepare("INSERT INTO usage_totals VALUES ('2026-11-02', 'browser', 'Chrome 130', 1)").run();
  assert.deepEqual(db.prepare('SELECT dimension, value, count FROM usage_totals ORDER BY dimension').all(), [
    { dimension: 'browser', value: 'Chrome 130', count: 1 },
    { dimension: 'device', value: 'phone', count: 3 },
    { dimension: 'source', value: 'linkedin', count: 2 },
  ]);
  assert.throws(() => db.prepare("INSERT INTO usage_totals VALUES ('2026-11-02', 'user', '1', 1)").run());
  assert.equal(usageBrowser.foreignKeys, false);
  db.close();
});

test('a location is "City, State, Country", or unknown', () => {
  assert.equal(locationValue(PLACES['203.0.113.7']), 'Springfield, Illinois, United States');
  assert.equal(locationValue({ city: null, state: 'Ohio', country: 'United States' }), 'Unknown, Ohio, United States');
  assert.equal(locationValue({ city: 'Washington, D.C.', state: null, country: 'United States' }), 'Washington D.C., Unknown, United States');
  assert.equal(locationValue(null), 'unknown');
  assert.equal(locationValue({ city: 'X', state: 'Y', country: '' }), 'unknown');
});

test('the source is one fixed category: utm_source from the list, else the whole Referer host', () => {
  /** @param {string | undefined} referer @param {string} [url] @param {{ siteHost?: string, demoHost?: string }} [hosts] */
  const from = (referer, url = '/', hosts = HOSTS) => sourceOf({ referer, url, ownOrigin: SITE, ...hosts });
  assert.equal(from(undefined, '/?utm_source=linkedin'), 'linkedin');
  assert.equal(from(undefined, '/?utm_source=GitHub'), 'github');
  assert.equal(from(undefined, '/?utm_source=site'), 'site');
  assert.equal(from(undefined, '/?utm_source=demo'), 'demo');
  // A spoofed or unknown utm_source falls through to the Referer.
  assert.equal(from(undefined, '/?utm_source=evil'), 'direct');
  assert.equal(from('https://news.example.net/', '/?utm_source=%3Cscript%3E'), 'other');
  assert.equal(from('https://www.linkedin.com/', '/?utm_source=google_signin_return'), 'linkedin');

  assert.equal(from('https://www.linkedin.com/feed/'), 'linkedin');
  assert.equal(from('https://lnkd.in/abc'), 'linkedin');
  assert.equal(from('https://github.com/someone/repo'), 'github');
  assert.equal(from('https://example.org/projects'), 'site');
  assert.equal(from('https://blog.example.org/post'), 'site');
  assert.equal(from('https://demo.example.org/'), 'demo');
  assert.equal(from('https://news.example.net/'), 'other');
  assert.equal(from('not a url'), 'other');
  assert.equal(from(undefined), 'direct');
  assert.equal(from(''), 'direct');

  // Lookalike hosts are other.
  for (const host of ['linkedin.com.example.com', 'notlinkedin.com', 'notgithub.com', 'gist.github.com', 'example.org.evil.test', 'demo.example.org.evil.test']) {
    assert.equal(from(`https://${host}/`), 'other', host);
  }
  // Unset site and demo hosts: their referrers are other.
  assert.equal(from('https://example.org/', '/', {}), 'other');
  assert.equal(from('https://demo.example.org/', '/', {}), 'other');

  // Returning from Google's sign-in is never a source, even with the original utm_source carried back.
  assert.equal(from('https://accounts.google.com/', '/?utm_source=linkedin'), GOOGLE_SIGNIN_RETURN);
  assert.ok(!SOURCES.includes(GOOGLE_SIGNIN_RETURN));
  // The app itself: internal navigation, not an arrival.
  assert.equal(from(`${SITE}/auth/signed-out`), null);
});

/** @param {{ authMode?: string }} [o] */
async function setup({ authMode = 'google' } = {}) {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: OWNER, SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  const sam = await addUser(store.raw, { email: 'sam@example.com', name: 'Sam' });
  const webDir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Job Hunt</title>');
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
  const app = await buildApp({
    store,
    config: DEMO_CONFIG,
    webDir,
    authMode,
    auth: { settings },
    usage: { location, ...HOSTS },
    services: fakeServices({ createBrowser: async () => null, log: { info() {}, warn() {}, error() {} } }),
  });
  const cookie = (/** @type {string} */ email) => `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`;
  /** @param {string} url @param {{ as?: string | null, ip?: string, ua?: string | null, headers?: Record<string, string> }} [o] */
  const get = (url, { as = OWNER, ip = '203.0.113.7', ua = UA.windows, headers = {} } = {}) =>
    app.inject({ url, remoteAddress: ip, headers: { ...(as ? { cookie: cookie(as) } : {}), ...(ua ? { 'user-agent': ua } : {}), origin: SITE, ...headers } });
  const totals = () => /** @type {Total[]} */ (store.raw.prepare('SELECT dimension, value, count FROM usage_totals ORDER BY dimension, value').all());
  return { app, store, sam, get, totals };
}

/** @param {string} [referer] */
const page = (referer) => ({ 'sec-fetch-dest': 'document', accept: 'text/html', ...(referer ? { referer } : {}) });

test('a visit counts once per account per day, by device, browser, and location', async () => {
  const { app, store, get, totals } = await setup();
  assert.equal((await get('/api/me')).statusCode, 200);
  await get('/api/me');
  await get('/api/summary');
  assert.deepEqual(totals(), [
    { dimension: 'browser', value: 'Chrome 130', count: 1 },
    { dimension: 'device', value: 'computer', count: 1 },
    { dimension: 'location', value: 'Springfield, Illinois, United States', count: 1 },
  ]);
  // A second account counts again; a lookup that misses or breaks is unknown.
  await get('/api/me', { as: 'sam@example.com', ip: '198.51.100.66', ua: UA.iphone });
  await get('/api/me', { as: 'sam@example.com', ip: '198.51.100.66', ua: UA.iphone });
  assert.deepEqual(totals(), [
    { dimension: 'browser', value: 'Chrome 130', count: 1 },
    { dimension: 'browser', value: 'Safari 18', count: 1 },
    { dimension: 'device', value: 'computer', count: 1 },
    { dimension: 'device', value: 'phone', count: 1 },
    { dimension: 'location', value: 'Springfield, Illinois, United States', count: 1 },
    { dimension: 'location', value: 'unknown', count: 1 },
  ]);
  await app.close();
  store.close();
});

test('nothing counts for health checks, assets, signed-out or refused calls, scripts, or the demo', async () => {
  const { app, store, get, totals } = await setup();
  await get('/healthz', { as: null });
  await get('/api/me', { as: null }); // signed out: 401
  await get('/api/admin/usage', { as: 'sam@example.com' }); // refused: 403
  await get('/api/me', { ua: null }); // no browser (the test client's own user agent)
  await get('/api/me', { ua: 'curl/8.5.0' }); // a script
  assert.equal((await get('/assets/app.js', { as: 'sam@example.com' })).statusCode, 200); // a static file
  await get('/api/me', { as: 'nobody@example.com' }); // no account: refused
  assert.deepEqual(totals(), []);
  await app.close();
  store.close();

  const demo = await setup({ authMode: 'demo' });
  await demo.get('/api/me', { as: null, headers: page('https://www.linkedin.com/') });
  await demo.get('/', { as: null, headers: page('https://www.linkedin.com/') });
  assert.deepEqual(demo.totals(), []);
  await demo.app.close();
  demo.store.close();
});

test('arrivals: page loads of the app or a direct sign-in link, by source; never sign-in returns or internal moves', async () => {
  const { app, store, get, totals } = await setup();
  const sources = () => totals().filter((r) => r.dimension === 'source').map(({ value, count }) => [value, count]);

  // Signed out from LinkedIn: / redirects to sign-in, counted once; the sign-in step after it is not counted again.
  const first = await get('/?utm_source=evil', { as: null, headers: page('https://www.linkedin.com/feed/') });
  assert.equal(first.statusCode, 302);
  await get(/** @type {string} */ (first.headers.location), { as: null, headers: page('https://www.linkedin.com/feed/') });
  assert.deepEqual(sources(), [['linkedin', 1]]);
  // Back from Google's sign-in to the main page: not a source.
  await get('/?utm_source=evil', { headers: page('https://accounts.google.com/') });
  // Internal navigation, and API calls and assets with an outside Referer: not arrivals.
  await get('/', { headers: page(`${SITE}/auth/signed-out`) });
  await get('/api/me', { headers: { referer: 'https://github.com/' } });
  await get('/assets/app.js', { headers: { 'sec-fetch-dest': 'script', referer: 'https://github.com/' } });
  assert.deepEqual(sources(), [['linkedin', 1]]);
  // A direct sign-in link, the demo by utm, a lookalike, and no Referer.
  await get('/auth/login', { as: null, headers: page('https://github.com/someone') });
  await get('/?utm_source=demo', { headers: page() });
  await get('/', { headers: page('https://linkedin.com.example.com/') });
  await get('/', { headers: page() });
  await get('/', { headers: { accept: 'text/html', referer: 'https://blog.example.org/' } }); // no Sec-Fetch-Dest: Accept decides
  assert.deepEqual(sources(), [['demo', 1], ['direct', 1], ['github', 1], ['linkedin', 1], ['other', 1], ['site', 1]]);
  await app.close();
  store.close();
});

test('the table holds no address, browser string, referrer, URL, or user id, and belongs to no account', async () => {
  const { app, store, sam, get, totals } = await setup();
  const referer = 'https://www.linkedin.com/in/someone-private';
  await get('/?utm_source=linkedin&secret=1', { headers: page(referer) });
  await get('/api/me', { as: 'sam@example.com', ua: UA.ipad });
  assert.deepEqual(store.raw.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').pluck().all('usage_totals'), ['day', 'dimension', 'value', 'count']);
  const text = JSON.stringify(store.raw.prepare('SELECT * FROM usage_totals').all());
  for (const leak of ['203.0.113', 'Mozilla', 'iPad;', 'someone-private', 'secret', 'utm_source', 'sam@example.com', OWNER]) assert.ok(!text.includes(leak), leak);
  for (const row of totals()) assert.ok(['device', 'browser', 'location', 'source'].includes(row.dimension));
  assert.ok(!text.includes('605.1.15') && !text.includes('AppleWebKit'), 'no user agent text');
  assert.ok(!totals().some((r) => r.value === String(sam)));
  assert.ok(!USER_TABLES.includes('usage_totals'));

  // The admin sees the totals for the period, each dimension on its own; a member gets 403.
  const res = await get('/api/admin/usage?weeks=4');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.devices, [{ value: 'computer', count: 1 }, { value: 'tablet', count: 1 }]);
  assert.deepEqual(body.browsers, [{ value: 'Chrome 130', count: 1 }, { value: 'Safari 18', count: 1 }]);
  assert.deepEqual(body.locations, [{ city: 'Springfield', state: 'Illinois', country: 'United States', count: 2 }]);
  assert.deepEqual(body.sources, [{ value: 'linkedin', count: 1 }]);
  assert.equal((await get('/api/admin/usage', { as: 'sam@example.com' })).statusCode, 403);

  // Not anyone's data: an account's export leaves it out, and deleting the account leaves the totals as they were.
  assert.ok(!JSON.stringify(exportAccount(store.raw, sam)).includes('usage_totals'));
  const before = totals();
  deleteAccount(store.raw, sam);
  assert.deepEqual(totals(), before);
  await app.close();
  store.close();
});
