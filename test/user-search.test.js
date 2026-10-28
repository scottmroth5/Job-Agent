// Multi-user, phase 3: each user's own search settings, background, pipeline, and schedule. Made-up accounts and
// settings; nothing reaches the network (the pipeline is faked, and the script check stops before any search).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.js';
import { runAsUser } from '../db/scope.js';
import { addUser, OWNER_ID } from '../db/users.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.js';
import { cleanConfig, configFor, saveUserConfig, saveUserProfile, scheduledUsers, setScheduledForUser, userConfigView } from '../agents/user-config.js';
import { repoPath } from '../tools/paths.js';

const SITE = 'http://localhost:5178';
const OWNER_CONFIG = {
  candidate: { name: 'Owner Example' },
  search: { terms: ['Owner Term'], relevantTitleKeywords: ['owner'], homeLocations: ['Ownertown, ST'] },
  fractional: { targetAnnual: [100000, 200000], weeksPerYear: 48 },
  coverLetterChecks: [{ label: 'x', text: 'owner-only pattern' }],
  privateTerms: ['owner example'],
};
const B_SEARCH = { candidate: { name: 'Sam' }, search: { terms: ['Head of Data'], relevantTitleKeywords: ['data'], homeLocations: ['Remote'] } };

test('a user sets plain text only: no patterns, no site search, no private terms; the owner keeps their file', () => {
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
  assert.deepEqual(c.fractional.targetAnnual, [150000, 300000]);
  assert.equal(c.ready, true);
  assert.equal(cleanConfig({}).ready, false);

  const { raw } = openJobStore(':memory:');
  assert.throws(() => saveUserConfig(raw, OWNER_ID, B_SEARCH), /job-search\.json/);
  assert.equal(saveUserProfile(raw, OWNER_ID, ' Owner background. '), 'Owner background.', 'the owner can keep About you in the app too');
});

test('the server config reads as whoever the request runs as', () => {
  const { raw } = openJobStore(':memory:');
  const b = addUser(raw, { email: 'b@example.com', name: 'Sam' });
  saveUserConfig(raw, b, B_SEARCH, 'Sam');
  const config = userConfigView(OWNER_CONFIG, raw);
  assert.deepEqual(config.search.terms, ['Owner Term'], 'outside a request: the owner');
  assert.deepEqual(runAsUser(b, () => config.search.terms), ['Head of Data']);
  assert.deepEqual(runAsUser(b, () => config.coverLetterChecks), []);
  assert.deepEqual(runAsUser(b, () => ({ ...config }).candidate.name), 'Sam', 'spreading works too');
  saveUserConfig(raw, b, { ...B_SEARCH, search: { ...B_SEARCH.search, terms: ['Chief Data Officer'] } }, 'Sam');
  assert.deepEqual(runAsUser(b, () => config.search.terms), ['Chief Data Officer'], 'a save shows at once');
  assert.equal(configFor(raw, OWNER_ID, OWNER_CONFIG), OWNER_CONFIG);
});

async function setup() {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  const b = addUser(store.raw, { email: 'b@example.com', name: 'Sam' });
  const runs = [];
  const app = await buildApp({
    store,
    config: OWNER_CONFIG,
    authMode: 'google',
    auth: { settings },
    services: {
      createBrowser: async () => null,
      knowledge: async () => 'the owner knowledge doc',
      runPipeline: async ({ user }) => {
        runs.push(user);
        return { code: 0, lastError: null };
      },
      log: { info() {}, warn() {}, error() {} },
    },
  });
  const as = (email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE });
  return { store, app, b, runs, asA: as('owner@example.com'), asB: as('b@example.com'), done: async () => { await app.close(); store.close(); } };
}

test('Settings: a user saves their search, background, and schedule; the owner is pointed at their file', async () => {
  const { store, app, b, asA, asB, done } = await setup();
  const get = (headers) => app.inject({ url: '/api/account/search', headers });
  // The owner: search settings stay in their file; About you can live here, and until it does their Google Doc is read.
  const own = (await get(asA)).json();
  assert.deepEqual({ owner: own.owner, profile: own.profile, from: own.aboutYouFrom }, { owner: true, profile: '', from: process.env.YOUR_KNOWLEDGE_DOC_ID ? 'google' : 'none' });
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
  assert.equal((await app.inject({ method: 'PUT', url: '/api/account/schedule', headers: asB, payload: { on: true } })).json().scheduled, true);
  assert.deepEqual(scheduledUsers(store.raw), [b]);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/account/schedule', headers: asA, payload: { on: true } })).statusCode, 400);

  // What the server shows each of them follows their own settings.
  assert.deepEqual((await app.inject({ url: '/api/summary', headers: asA })).json().fractionalTarget, [100000, 200000]);
  assert.equal((await app.inject({ url: '/api/summary', headers: asB })).json().fractionalTarget, null);
  // The owner's settings and background never reach B.
  for (const url of ['/api/account/search', '/api/account', '/api/summary', '/api/me']) {
    const body = (await app.inject({ url, headers: asB })).body;
    assert.ok(!body.includes('Owner Term') && !body.includes('owner knowledge') && !body.includes('owner-only pattern'), url);
  }
  // A paused user's pipeline is off the schedule.
  store.raw.prepare("UPDATE users SET status = 'paused' WHERE id = ?").run(b);
  assert.deepEqual(scheduledUsers(store.raw), []);
  setScheduledForUser(store.raw, b, false);
  await done();
});

test('the pipeline button runs the pipeline as whoever pressed it, one at a time', async () => {
  const { app, b, runs, asA, asB, done } = await setup();
  const start = async (headers) => app.inject({ method: 'POST', url: '/api/pipeline/run', headers });
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

test('the pipeline script refuses a user who has not set up a search, before any search', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-user-'));
  try {
    const store = openJobStore(join(dir, 'job-agent.db'), { log: {} });
    const b = addUser(store.raw, { email: 'b@example.com', name: 'Sam' });
    const paused = addUser(store.raw, { email: 'c@example.com', status: 'paused' });
    store.close();
    const run = (args) => spawnSync(process.execPath, [repoPath('scripts', 'pipeline.js'), ...args, '--no-email'], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 30000 });
    const notReady = run([`--user=${b}`]);
    assert.equal(notReady.status, 1);
    assert.match(notReady.stderr, /Set up your search/);
    assert.match(run([`--user=${paused}`]).stderr, /not an active account/);
    assert.notEqual(run(['--user=abc']).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
