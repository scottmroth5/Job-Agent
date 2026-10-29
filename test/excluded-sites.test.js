// Job sites to skip (agents/excluded-sites.js, server/excluded-sites-routes.js): each user's own list with notes, added
// to the settings file's search.excludedSites for everything that reads it; removing a site's saved jobs keeps the ones
// you applied to. Synthetic data on example domains only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { runAsUser } from '../db/scope.js';
import { addUser, OWNER_ID } from '../db/users.js';
import { buildApp } from '../server/app.js';
import { addExcludedSite, excludedSites, removeExcludedSite, setExcludedSiteNote, siteOf, withExcludedSites } from '../agents/excluded-sites.js';
import { configFor, saveUserConfig } from '../agents/user-config.js';

const config = { candidate: { name: 'Pat Example' }, coverLetterChecks: [], search: { terms: ['VP Engineering'], homeLocations: [], excludedSites: ['filesite.example'] }, fractional: {} };

test('a site is the link or domain as a lowercase host without www', () => {
  assert.equal(siteOf('https://www.PaywallJobs.example/jobs/123?x=1'), 'paywalljobs.example');
  assert.equal(siteOf('  Paywalljobs.example '), 'paywalljobs.example');
  assert.equal(siteOf('jobs.paywalljobs.example/listing'), 'jobs.paywalljobs.example');
  for (const bad of ['', 'paywall', 'not a site', 'http://', 'x'.repeat(400), 'a..example', '-'.repeat(500)]) {
    assert.throws(() => siteOf(bad), /Enter a site/, JSON.stringify(bad.slice(0, 20)));
  }
});

test('add, note, and remove; adding again updates the note; the owner keeps the file entries too', () => {
  const { db } = openJobStore(':memory:');
  assert.deepEqual(excludedSites(db, OWNER_ID), []);
  addExcludedSite(db, OWNER_ID, { site: 'https://paywall.example/job/1', note: 'Paywall' });
  addExcludedSite(db, OWNER_ID, { site: 'reposts.example' });
  addExcludedSite(db, OWNER_ID, { site: 'www.paywall.example', note: 'Paywall I will never pay' });
  assert.deepEqual(excludedSites(db, OWNER_ID).map(({ site, note }) => [site, note]), [['paywall.example', 'Paywall I will never pay'], ['reposts.example', '']]);
  setExcludedSiteNote(db, OWNER_ID, 'reposts.example', 'Old reposts');
  assert.equal(excludedSites(db, OWNER_ID)[1].note, 'Old reposts');
  assert.deepEqual(withExcludedSites(db, OWNER_ID, config).search.excludedSites, ['filesite.example', 'paywall.example', 'reposts.example']);
  assert.deepEqual(config.search.excludedSites, ['filesite.example'], 'the base config is not changed');
  assert.deepEqual(configFor(db, OWNER_ID, config).search.excludedSites, ['filesite.example', 'paywall.example', 'reposts.example'], 'scripts and the server see them');
  removeExcludedSite(db, OWNER_ID, 'reposts.example');
  assert.throws(() => removeExcludedSite(db, OWNER_ID, 'reposts.example'), /not on your list/);
  assert.deepEqual(excludedSites(db, OWNER_ID).map((s) => s.site), ['paywall.example']);
});

test("another user's sites from their saved search move into the list, and only theirs apply to them", () => {
  const { raw } = openJobStore(':memory:');
  const b = addUser(raw, { email: 'b@example.com', name: 'Sam' });
  saveUserConfig(raw, b, { candidate: { name: 'Sam' }, search: { terms: ['Head of Data'], excludedSites: ['old.example'] } }, 'Sam');
  addExcludedSite(raw, OWNER_ID, { site: 'ownerskip.example' });
  const legacy = ['old.example'];
  assert.deepEqual(excludedSites(raw, b, { legacy }).map((s) => s.site), ['old.example']);
  addExcludedSite(raw, b, { site: 'new.example', note: 'Charges to apply' }, { legacy });
  assert.deepEqual(excludedSites(raw, b, { legacy }).map((s) => s.site), ['old.example', 'new.example']);
  removeExcludedSite(raw, b, 'old.example', { legacy });
  assert.deepEqual(configFor(raw, b, null).search.excludedSites, ['new.example'], "removed stays removed; the owner's are not theirs");
});

async function setup() {
  const store = openJobStore(':memory:');
  const { db } = store;
  const add = (url, status) =>
    Number(
      db.prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, stage, status, discovered_on, created_at, updated_at)
        VALUES (1, ?, ?, 'Example Co', ?, ?, 'pipeline', ?, '2026-10-01', 'x', 'x')`).run(url, url, `Role ${status} ${url}`, `k ${url}`, status).lastInsertRowid,
    );
  const ids = { fresh: add('https://www.paywall.example/job/1', 'new'), applied: add('https://paywall.example/job/2', 'applied'), other: add('https://jobs.example.com/3', 'new') };
  const app = await buildApp({ store, config, services: { createBrowser: async () => null, log: { info() {}, warn() {}, error() {} } } });
  return { store, db, app, ids };
}

test('the routes: skip from a job link, count saved jobs, remove them (not the applied one), note, and stop skipping', async () => {
  const { store, db, app, ids } = await setup();
  const list = async () => (await app.inject({ method: 'GET', url: '/api/excluded-sites' })).json();
  assert.deepEqual((await list()).fromFile, [{ site: 'filesite.example', savedJobs: 0 }]);

  const added = await app.inject({ method: 'POST', url: '/api/excluded-sites', payload: { site: 'https://www.paywall.example/job/1', note: 'Paywall' } });
  assert.equal(added.statusCode, 201);
  assert.equal(added.json().site, 'paywall.example');
  assert.deepEqual(added.json().sites.map(({ site, note, savedJobs }) => [site, note, savedJobs]), [['paywall.example', 'Paywall', 1]], 'the applied job does not count');
  assert.equal((await app.inject({ method: 'POST', url: '/api/excluded-sites', payload: { site: 'nonsense' } })).statusCode, 400);

  const removed = await app.inject({ method: 'POST', url: '/api/excluded-sites/paywall.example/remove-jobs' });
  assert.equal(removed.json().removed, 1);
  const status = (id) => db.prepare('SELECT stage, status FROM postings WHERE id = ? AND user_id = @uid').get(id);
  assert.deepEqual(status(ids.fresh), { stage: 'archived', status: 'passed' });
  assert.deepEqual(status(ids.applied), { stage: 'pipeline', status: 'applied' }, 'a job you applied to is kept');
  assert.deepEqual(status(ids.other), { stage: 'pipeline', status: 'new' });
  assert.equal((await app.inject({ method: 'POST', url: '/api/excluded-sites/unlisted.example/remove-jobs' })).statusCode, 404);

  assert.equal((await app.inject({ method: 'PATCH', url: '/api/excluded-sites/paywall.example', payload: { note: 'Paywall I will never pay' } })).json().sites[0].note, 'Paywall I will never pay');
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/excluded-sites/Bad Site', payload: { note: 'x' } })).statusCode, 400);

  // What discovery, scoring, and adding a job read (the server's config) has the site at once.
  assert.ok(configFor(store.raw, OWNER_ID, config).search.excludedSites.includes('paywall.example'));

  assert.deepEqual((await app.inject({ method: 'DELETE', url: '/api/excluded-sites/paywall.example' })).json().sites, []);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/excluded-sites/paywall.example' })).statusCode, 404);
  await app.close();
  store.close();
});

test("each user's list is their own", async () => {
  const { store, app } = await setup();
  const b = addUser(store.raw, { email: 'b@example.com', name: 'Sam' });
  addExcludedSite(store.raw, OWNER_ID, { site: 'ownerskip.example', note: 'Mine' });
  assert.deepEqual(runAsUser(b, () => excludedSites(store.db, b)), []);
  assert.deepEqual(excludedSites(store.db, OWNER_ID).map((s) => s.site), ['ownerskip.example']);
  await app.close();
  store.close();
});
