// Multi-user, phase 3: each user's own search settings, background, pipeline, and schedule. Made-up accounts and
// settings; nothing reaches the network (the pipeline is faked, and the script check stops before any search).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.ts';
import { runAsUser } from '../db/scope.ts';
import { addUser, OWNER_ID } from '../db/users.ts';
import { buildApp } from '../server/app.ts';
import { authSettings } from '../server/auth.ts';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.ts';
import { cleanConfig, configFor, saveUserConfig, saveUserProfile, userConfigView, withUserConfig } from '../agents/user-config.ts';
import { automatedUsers } from '../agents/automation.ts';
import { repoPath } from '../tools/paths.ts';
import { fakeConfig, fakeServices } from './fixtures/fakes.js';

const SITE = 'http://localhost:5178';
const OWNER_CONFIG = fakeConfig({
  candidate: { name: 'Owner Example' },
  search: { terms: ['Owner Term'], relevantTitleKeywords: ['owner'], homeLocations: ['Ownertown, ST'] },
  fractional: { targetAnnual: [100000, 200000], weeksPerYear: 48 },
  coverLetterChecks: [{ label: 'x', text: 'owner-only pattern' }],
  privateTerms: ['owner example'],
});
const B_SEARCH = { candidate: { name: 'Sam' }, search: { terms: ['Head of Data'], relevantTitleKeywords: ['data'], homeLocations: ['Remote'] } };

test('a user sets plain text only: no patterns, no site search, no private terms; the owner keeps their file', async () => {
  const c = cleanConfig({
    ...B_SEARCH,
    coverLetterChecks: [{ label: 'evil', text: '(a+)+$' }],
    privateTerms: ['x'],
    search: { ...B_SEARCH.search, siteSearch: true, terms: ['  Head of Data  ', '', 'x'.repeat(500)] },
    fractional: { targetAnnual: [300000, 150000] },
  });
  assert.deepEqual(c.coverLetterChecks, []);
  assert.deepEqual(c.privateTerms, []);
  assert.equal(c.search.siteSearch, false);
  assert.deepEqual(c.search.terms.map((t) => t.length), [12, 200], 'trimmed, blanks dropped, long values cut');
  assert.deepEqual(c.fractional?.targetAnnual, [150000, 300000]);
  assert.equal(c.ready, true);
  assert.equal(cleanConfig({}).ready, false);

  const { admin: raw } = openJobStore(':memory:');
  await assert.rejects(async () => await saveUserConfig(raw, OWNER_ID, B_SEARCH), /job-search\.json/);
  assert.equal(await saveUserProfile(raw, OWNER_ID, ' Owner background. '), 'Owner background.', 'the owner can keep About you in the app too');
});

test('the server config reads as whoever the request runs as', async () => {
  const { admin: raw } = openJobStore(':memory:');
  const b = await addUser(raw, { email: 'b@example.com', name: 'Sam' });
  await saveUserConfig(raw, b, B_SEARCH, 'Sam');
  const config = userConfigView(OWNER_CONFIG, raw);
  // The server loads the settings before each route (withUserConfig in its preHandler); reads then answer at once.
  const as = (/** @type {number} */ uid, /** @type {() => unknown} */ fn) => runAsUser(uid, () => withUserConfig(raw, uid, OWNER_CONFIG, fn));
  assert.throws(() => config.search, /before they were loaded/, 'never a guess: unloaded settings are an error');
  assert.deepEqual(await as(OWNER_ID, () => config.search.terms), ['Owner Term'], 'the owner: their file');
  assert.deepEqual(await as(b, () => config.search.terms), ['Head of Data']);
  assert.deepEqual(await as(b, () => config.coverLetterChecks), []);
  assert.deepEqual(await as(b, () => ({ ...config }).candidate.name), 'Sam', 'spreading works too');
  const seen = await as(b, async () => {
    await saveUserConfig(raw, b, { ...B_SEARCH, search: { ...B_SEARCH.search, terms: ['Chief Data Officer'] } }, 'Sam');
    return config.search.terms;
  });
  assert.deepEqual(seen, ['Chief Data Officer'], 'a save shows at once, in the rest of the same request too');
  assert.deepEqual(await as(b, () => config.search.terms), ['Chief Data Officer'], 'and in the next one');
  assert.deepEqual(await configFor(raw, OWNER_ID, OWNER_CONFIG), OWNER_CONFIG, "the owner's file, with no sites skipped on Settings");
});

async function setup() {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  const b = await addUser(store.admin, { email: 'b@example.com', name: 'Sam' });
  /** @type {Array<number | undefined>} */
  const runs = [];
  const app = await buildApp({
    store,
    config: OWNER_CONFIG,
    authMode: 'google',
    auth: { settings },
    services: fakeServices({
      createBrowser: async () => null,
      knowledge: async () => 'the owner knowledge doc',
      runPipeline: async ({ user }) => {
        runs.push(user);
        return { code: 0, lastError: null };
      },
      log: { info() {}, warn() {}, error() {} },
    }),
  });
  const as = (/** @type {string} */ email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE });
  return { store, app, b, runs, asA: as('owner@example.com'), asB: as('b@example.com'), done: async () => { await app.close(); store.close(); } };
}

test('Settings: a user saves their search, background, and schedule; the owner is pointed at their file', async () => {
  const { store, app, b, asA, asB, done } = await setup();
  const get = (/** @type {Record<string, string>} */ headers) => app.inject({ url: '/api/account/search', headers });
  // The owner: search settings stay in their file; their knowledge doc lives here, like everyone's.
  const own = (await get(asA)).json();
  assert.deepEqual({ owner: own.owner, profile: own.profile }, { owner: true, profile: '' });
  assert.equal(own.config, undefined, "the owner's settings file is not sent");
  const empty = (await get(asB)).json();
  assert.equal(empty.config.ready, false);
  assert.ok(empty.problems.length > 0);

  const saved = await app.inject({ method: 'PUT', url: '/api/account/search', headers: asB, payload: B_SEARCH });
  assert.deepEqual([saved.statusCode, saved.json().config.ready, saved.json().problems], [200, true, []]);
  const sneaky = await app.inject({ method: 'PUT', url: '/api/account/search', headers: asB, payload: { ...B_SEARCH, coverLetterChecks: [{ label: 'x', text: '(a+)+$' }] } });
  assert.deepEqual(sneaky.json().config.coverLetterChecks, [], 'unknown fields are dropped (Fastify removeAdditional), never saved');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/account/search', headers: asA, payload: B_SEARCH })).statusCode, 400);

  const about = 'Fifteen years leading data teams. '.repeat(20);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/account/profile', headers: asB, payload: { text: about } })).json().profile, about.trim());
  assert.equal((await app.inject({ method: 'PUT', url: '/api/account/profile', headers: asB, payload: { text: 'x'.repeat(60000) } })).statusCode, 400);
  const NONE = { pipeline: null, inbox: null };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/account/automation', headers: asB, payload: { on: true, pipeline: 'Mon 06:00' } })).json().on, true);
  assert.deepEqual((await automatedUsers(store.admin, NONE)).map((u) => u.uid), [b]);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/account/automation', headers: asB, payload: { on: true, inbox: { afterPipeline: true } } })).statusCode, 400, 'only the owner has an inbox');

  // What the server shows each of them follows their own settings.
  assert.deepEqual((await app.inject({ url: '/api/summary', headers: asA })).json().fractionalTarget, [100000, 200000]);
  assert.equal((await app.inject({ url: '/api/summary', headers: asB })).json().fractionalTarget, null);
  // The owner's settings and background never reach B.
  for (const url of ['/api/account/search', '/api/account', '/api/summary', '/api/me']) {
    const body = (await app.inject({ url, headers: asB })).body;
    assert.ok(!body.includes('Owner Term') && !body.includes('owner knowledge') && !body.includes('owner-only pattern'), url);
  }
  // A paused user's pipeline is off the schedule.
  await store.admin.prepare("UPDATE users SET status = 'paused' WHERE id = ?").run(b);
  assert.deepEqual(await automatedUsers(store.admin, NONE), []);
  await done();
});

test('the pipeline button runs the pipeline as whoever pressed it, one at a time', async () => {
  const { app, b, runs, asA, asB, done } = await setup();
  const start = async (/** @type {Record<string, string>} */ headers) => app.inject({ method: 'POST', url: '/api/pipeline/run', headers });
  assert.equal((await start(asB)).statusCode, 202);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await start(asA)).statusCode, 202);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(runs, [b, OWNER_ID]);
  // The inbox stays the owner's.
  const check = await app.inject({ method: 'POST', url: '/api/inbox/check', headers: asB });
  assert.ok([403, 404].includes(check.statusCode));
  await done();
});

test('the pipeline script refuses a user who has not set up a search, before any search', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-user-'));
  try {
    const store = openJobStore(join(dir, 'job-agent.db'), { log: {} });
    const b = await addUser(store.admin, { email: 'b@example.com', name: 'Sam' });
    const paused = await addUser(store.admin, { email: 'c@example.com', status: 'paused' });
    store.close();
    const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [repoPath('scripts', 'pipeline.js'), ...args, '--no-email'], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 30000 });
    const notReady = run([`--user=${b}`]);
    assert.equal(notReady.status, 1);
    assert.match(notReady.stderr, /Set up your search/);
    assert.match(run([`--user=${paused}`]).stderr, /not an active account/);
    assert.notEqual(run(['--user=abc']).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
