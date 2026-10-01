import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as himalayas from '../agents/discovery/sources/himalayas.js';
import * as remoteok from '../agents/discovery/sources/remoteok.js';
import * as linkedin from '../agents/discovery/sources/linkedin.js';
import * as serper from '../agents/discovery/sources/serper.js';
import { resolveDetails } from '../agents/discovery/details.js';
import { runDiscovery } from '../agents/discovery/discover.js';
import { openJobStore } from '../db/index.js';
import { RateLimitedError, HttpError } from '../tools/http.js';

// All data below is made up; only the response shapes mirror the real sources.
const LONG = 'Lead a platform engineering organization of forty engineers. '.repeat(10);

// ---------- source parsers ----------
test('himalayas parses dates from pubDate, descriptions and location restrictions', () => {
  const item = himalayas.parseJob({
    title: 'VP of Engineering',
    companyName: 'Example Co',
    pubDate: Date.UTC(2026, 8, 25) / 1000,
    description: '<p>Build things.</p>',
    locationRestrictions: ['United States', 'Canada'],
    employmentType: 'Full Time',
    minSalary: 200000,
    maxSalary: 240000,
    currency: 'USD',
    applicationLink: 'https://himalayas.app/companies/example/jobs/vp',
    guid: 'https://himalayas.app/companies/example/jobs/vp',
  });
  assert.equal(item.postedOn, '2026-09-25');
  assert.equal(item.location, 'Remote (United States, Canada)');
  assert.equal(item.workplace, 'remote');
  assert.equal(item.salary, '$200k - $240k');
  assert.equal(item.description, 'Build things.');
});

test('remoteok skips the metadata element and maps jobs', () => {
  const items = remoteok.parseResponse([
    { legal: 'terms' },
    { id: 5, position: 'Head of Engineering', company: 'Example Co', epoch: Date.UTC(2026, 8, 20) / 1000, description: '<p>x</p>', url: 'https://remoteok.com/remote-jobs/5', tags: ['contract'] },
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(
    { title: items[0].title, postedOn: items[0].postedOn, jobType: items[0].jobType, workplace: items[0].workplace },
    { title: 'Head of Engineering', postedOn: '2026-09-20', jobType: 'Contract', workplace: 'remote' },
  );
});

const card = ({ id, title, company, location, date }) => `<li>
  <div class="base-card" data-entity-urn="urn:li:jobPosting:${id}">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/x-at-y-${id}?refId=abc&amp;trk=z"></a>
    <h3 class="base-search-card__title">
          ${title}
    </h3>
    <h4 class="base-search-card__subtitle"><a href="#">${company}</a></h4>
    <span class="job-search-card__location">${location}</span>
    <time class="job-search-card__listdate" datetime="${date}">2 days ago</time>
  </div></li>`;

test('linkedin parses search cards; remote mode marks jobs remote', () => {
  const html = card({ id: '4000000001', title: 'VP Engineering &amp; Platform', company: 'Example Co', location: 'Newark, NJ', date: '2026-09-26' });
  const [remote] = linkedin.parseSearchPage(html, 'remote');
  assert.deepEqual(
    { id: remote.linkedinJobId, title: remote.title, company: remote.company, location: remote.location, postedOn: remote.postedOn, workplace: remote.workplace, url: remote.url },
    { id: '4000000001', title: 'VP Engineering & Platform', company: 'Example Co', location: 'Newark, NJ', postedOn: '2026-09-26', workplace: 'remote', url: 'https://www.linkedin.com/jobs/view/x-at-y-4000000001' },
  );
  assert.equal(linkedin.parseSearchPage(html, 'local')[0].workplace, null);
  assert.match(linkedin.searchUrl({ keywords: 'CTO', mode: 'local', localLocation: 'Anytown Metro Area', start: 10 }), /location=Anytown\+Metro\+Area&distance=25/);
  assert.match(linkedin.searchUrl({ keywords: 'CTO', mode: 'remote' }), /f_WT=2/);
});

test('linkedin parses the guest posting page', () => {
  const html = `<div class="show-more-less-html__markup"><p>Lead engineering.</p><ul><li>Hire</li></ul></div>
    <h3 class="description__job-criteria-subheader">Seniority level</h3><span class="description__job-criteria-text">Executive</span>
    <h3 class="description__job-criteria-subheader">Employment type</h3><span class="description__job-criteria-text">Full-time</span>`;
  assert.deepEqual(linkedin.parsePosting(html), { title: null, company: null, location: null, description: 'Lead engineering.\n- Hire', jobType: 'Full-time', seniority: 'Executive' });
  const top = `<h2 class="top-card-layout__title font-sans">VP, Platform &amp; Data</h2>
    <a class="topcard__org-name-link topcard__flavor--black-link" href="#">  Example Co </a>
    <span class="topcard__flavor topcard__flavor--bullet"> Anytown, ST </span>`;
  assert.deepEqual(
    (({ title, company, location }) => ({ title, company, location }))(linkedin.parsePosting(top)),
    { title: 'VP, Platform & Data', company: 'Example Co', location: 'Anytown, ST' },
  );
  assert.equal(linkedin.jobIdFromUrl('https://www.linkedin.com/jobs/view/vp-at-example-4000000002/'), '4000000002');
});

test('serper parses company and title from common result formats', () => {
  assert.deepEqual(serper.parseResultTitle('Example Co hiring VP of Engineering in Denver, CO | LinkedIn'), { title: 'VP of Engineering', company: 'Example Co', location: 'Denver, CO' });
  assert.deepEqual(serper.parseResultTitle('VP of Engineering - Example Co - Remote Rocketship'), { title: 'VP of Engineering', company: 'Example Co', location: null });
  assert.deepEqual(serper.parseResultTitle('Head of Engineering at Example Co'), { title: 'Head of Engineering', company: 'Example Co', location: null });
  assert.deepEqual(serper.parseResultTitle('Job Application for Director of Engineering at Example Co'), { title: 'Director of Engineering', company: 'Example Co', location: null });
  assert.deepEqual(serper.parseResultTitle('CTO | Indeed'), { title: 'CTO', company: null, location: null });
  const item = serper.parseResult({ title: 'CTO - Example Co', link: 'https://www.linkedin.com/jobs/view/4000000003' }, 'CTO');
  assert.equal(item.linkedinJobId, '4000000003');
  assert.ok(serper.isNonJobSite('https://www.instagram.com/p/abc/'));
  assert.ok(!serper.isNonJobSite('https://jobs.example.com/1'));
  assert.ok(!serper.isNonJobSite('https://www.linkedin.com/jobs/view/1'));
});

// ---------- details ----------
const fakeHttp = (routes) => ({
  calls: [],
  async get(url) {
    this.calls.push(url);
    for (const [pattern, reply] of routes) {
      if (url.includes(pattern)) {
        if (reply instanceof Error) throw reply;
        return { status: 200, text: reply, url };
      }
    }
    throw new HttpError(url, 404);
  },
  sleep: async () => {},
});

test('details: source text, LinkedIn endpoint, JSON-LD, page text, then browser', async () => {
  const fromSource = await resolveDetails({ description: LONG }, { http: fakeHttp([]) });
  assert.equal(fromSource.fetchMethod, 'source');

  const li = await resolveDetails(
    { linkedinJobId: '4000000004' },
    { http: fakeHttp([['jobPosting/4000000004', `<div class="show-more-less-html__markup">${LONG}</div>`]]) },
  );
  assert.equal(li.fetchMethod, 'linkedin');

  const ld = { '@type': 'JobPosting', title: 'CTO', hiringOrganization: { name: 'Example Co' }, description: LONG, jobLocationType: 'TELECOMMUTE' };
  const viaLd = await resolveDetails(
    { url: 'https://jobs.example.com/1', company: null, title: 'CTO' },
    { http: fakeHttp([['jobs.example.com/1', `<script type="application/ld+json">${JSON.stringify(ld)}</script>`]]) },
  );
  assert.deepEqual([viaLd.fetchMethod, viaLd.company, viaLd.workplace], ['jsonld', 'Example Co', 'remote']);

  const viaHtml = await resolveDetails({ url: 'https://jobs.example.com/2' }, { http: fakeHttp([['jobs.example.com/2', `<p>${LONG.repeat(2)}</p>`]]) });
  assert.equal(viaHtml.fetchMethod, 'html');

  const shell = fakeHttp([['jobs.example.com/3', '<div id="app"></div>']]);
  assert.equal((await resolveDetails({ url: 'https://jobs.example.com/3' }, { http: shell })).fetchStatus, 'needs_browser');
  const browser = { renderPage: async () => ({ html: '<p>rendered</p>', text: LONG }) };
  assert.equal((await resolveDetails({ url: 'https://jobs.example.com/3' }, { http: shell, browser })).fetchMethod, 'browser');
});

test('details: bot-check pages are marked blocked, not treated as posting text', async () => {
  const check = 'example.com\nPerforming security verification\nThis website uses a security service to protect against malicious bots.';
  const shell = fakeHttp([['jobs.example.com/4', '<div id="app"></div>']]);
  const browser = { renderPage: async () => ({ html: '', text: check }) };
  const item = await resolveDetails({ url: 'https://jobs.example.com/4' }, { http: shell, browser });
  assert.equal(item.fetchStatus, 'blocked');
  assert.equal(item.description, undefined);
});

test('details: a second LinkedIn 429 stops further LinkedIn requests', async () => {
  const http = fakeHttp([['jobPosting/', new RateLimitedError('https://www.linkedin.com/x')]]);
  const state = {};
  assert.equal((await resolveDetails({ linkedinJobId: '1' }, { http, state })).fetchStatus, 'rate_limited');
  assert.equal(state.linkedinBlocked, true);
  await resolveDetails({ linkedinJobId: '2' }, { http, state });
  assert.equal(http.calls.length, 2, 'the original request and one retry after the pause; none for the second job');
});

// ---------- full run ----------
const config = {
  search: {
    terms: ['VP Engineering'],
    relevantTitleKeywords: ['vp', 'cto', 'head of engineering'],
    noiseTitleKeywords: ['intern'],
    homeLocations: ['Portland, OR', 'Beaverton, OR'],
  },
};

const fakeSource = (SOURCE, items) => ({ SOURCE, search: async () => ({ items: items.map((i) => ({ source: SOURCE, ...i })), requests: 1, errors: [], rateLimited: false }) });
const base = (o) => ({ company: 'Example Co', location: 'Remote', workplace: 'remote', postedOn: '2026-09-28', description: LONG, ...o });

function seedPosting(db, { url, company, title, source = 'LinkedIn', stage = 'discovered' }) {
  db.prepare(`INSERT INTO postings (url, url_key, company, title, company_title_key, source, discovered_on, stage, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '2026-09-01', ?, 'x', 'x')`).run(url, url.replace('https://', ''), company, title, `${company.toLowerCase()}|${title.toLowerCase()}`, source, stage);
}

test('runDiscovery filters, dedupes by priority, checks location, and stores new postings', async () => {
  const store = openJobStore(':memory:');
  seedPosting(store.db, { url: 'https://old.example.com/job', company: 'Old Co', title: 'CTO' });
  const sources = {
    linkedin: fakeSource('LinkedIn', [
      base({ url: 'https://www.linkedin.com/jobs/view/4000000010', title: 'VP Engineering', company: 'Dup Co' }), // same job as Himalayas below
      base({ url: 'https://www.linkedin.com/jobs/view/4000000011', title: 'Head of Engineering', location: 'Beaverton, OR', workplace: null }),
      base({ url: 'https://www.linkedin.com/jobs/view/4000000012', title: 'CTO', location: 'Portland, ME', workplace: null }),
      base({ url: 'https://www.linkedin.com/jobs/view/4000000013', title: 'Director of Sales' }), // not relevant
      base({ url: 'https://www.linkedin.com/jobs/view/4000000014', title: 'VP Product', postedOn: '2026-08-01' }), // stale
    ]),
    himalayas: fakeSource('Himalayas', [
      base({ url: 'https://himalayas.app/jobs/vp', title: 'VP Engineering', company: 'Dup Co' }),
      base({ url: 'https://old.example.com/job', title: 'CTO', company: 'Old Co' }), // already in the database
    ]),
  };
  const summary = await runDiscovery({
    store,
    config,
    http: { sleep: async () => {} },
    sources,
    now: new Date('2026-09-30T12:00:00Z'),
    options: { pauseMs: 0 },
  });

  assert.equal(summary.inserted, 3);
  assert.deepEqual(summary.locationChecks, { remote: 1, home: 1, conflict: 1 });
  assert.equal(summary.bySource.Himalayas.new, 1, 'the API source wins the in-run duplicate');
  assert.equal(summary.bySource.LinkedIn.duplicates, 1);
  assert.equal(summary.bySource.LinkedIn.relevant, 4);
  assert.equal(summary.bySource.LinkedIn.fresh, 3);
  assert.equal(summary.bySource.Himalayas.duplicates, 1);

  const rows = store.db.prepare("SELECT source, title, location_check, stage, status, fetch_method FROM postings WHERE discovered_on = '2026-09-30' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.source, r.title, r.location_check]), [
    ['Himalayas', 'VP Engineering', 'remote'],
    ['LinkedIn', 'Head of Engineering', 'home'],
    ['LinkedIn', 'CTO', 'conflict'],
  ]);
  assert.ok(rows.every((r) => r.stage === 'discovered' && r.status === 'new' && r.fetch_method === 'source'));
  // The existing posting got a sighting from Himalayas and was upgraded to it.
  const old = store.db.prepare("SELECT source FROM postings WHERE company = 'Old Co'").get();
  assert.equal(old.source, 'Himalayas');
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM posting_sightings').pluck().get(), 4);

  // A second identical run inserts nothing.
  const again = await runDiscovery({ store, config, http: { sleep: async () => {} }, sources, now: new Date('2026-09-30T13:00:00Z'), options: { pauseMs: 0 } });
  assert.equal(again.inserted, 0);
  store.close();
});

test('details: after the first LinkedIn 429 the run waits once and retries', async () => {
  let calls = 0;
  const slept = [];
  const http = {
    async get() {
      calls += 1;
      if (calls === 1) throw new RateLimitedError('https://www.linkedin.com/x');
      return { status: 200, text: `<div class="show-more-less-html__markup">${LONG}</div>` };
    },
    sleep: async (ms) => slept.push(ms),
  };
  const state = {};
  assert.equal((await resolveDetails({ linkedinJobId: '5' }, { http, state })).fetchMethod, 'linkedin');
  assert.deepEqual(slept, [60000]);
  assert.equal(state.linkedinBlocked, undefined);
});

test('runDiscovery retries recent postings whose text failed earlier, then stops after 3 attempts', async () => {
  const store = openJobStore(':memory:');
  const insertPending = (url, attempts, discoveredOn = '2026-09-29') =>
    store.db.prepare(`INSERT INTO postings (url, url_key, company, title, company_title_key, source, discovered_on, stage,
      fetch_status, fetch_attempts, location, location_check, created_at, updated_at)
      VALUES (?, ?, '(unknown)', 'CTO', ?, 'Google Jobs', ?, 'discovered', 'rate_limited', ?, NULL, 'unknown', 'x', 'x')`)
      .run(url, url, `(unknown)|cto|${url}`, discoveredOn, attempts);
  insertPending('https://jobs.example.com/a', 1);
  insertPending('https://jobs.example.com/b', 3); // out of attempts
  insertPending('https://jobs.example.com/c', 1, '2026-09-01'); // too old
  const ld = { '@type': 'JobPosting', hiringOrganization: { name: 'Found Co' }, description: LONG, jobLocation: { address: { addressLocality: 'Beaverton', addressRegion: 'OR' } } };
  const http = fakeHttp([['jobs.example.com/a', `<script type="application/ld+json">${JSON.stringify(ld)}</script>`]]);

  const summary = await runDiscovery({ store, config, http, sources: {}, now: new Date('2026-09-30T12:00:00Z'), options: { pauseMs: 0 } });
  assert.deepEqual(summary.retried, { attempted: 1, fixed: 1 });
  const row = store.db.prepare("SELECT company, location, location_check, fetch_status, fetch_attempts FROM postings WHERE url = 'https://jobs.example.com/a'").get();
  assert.deepEqual(row, { company: 'Found Co', location: 'Beaverton, OR', location_check: 'home', fetch_status: 'ok', fetch_attempts: 2 });
  assert.deepEqual(http.calls, ['https://jobs.example.com/a']);
  store.close();
});

test('runDiscovery dry run writes nothing and a failing source does not stop the run', async () => {
  const store = openJobStore(':memory:');
  const sources = {
    himalayas: { SOURCE: 'Himalayas', search: async () => { throw new Error('boom'); } },
    remoteok: fakeSource('RemoteOK', [base({ url: 'https://remoteok.com/1', title: 'CTO' })]),
  };
  const summary = await runDiscovery({ store, config, http: { sleep: async () => {} }, sources, now: new Date('2026-09-30T12:00:00Z'), options: { dryRun: true } });
  assert.equal(summary.wouldInsert, 1);
  assert.equal(summary.inserted, 0);
  assert.deepEqual(summary.bySource.Himalayas.errors, ['boom']);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM postings').pluck().get(), 0);
  store.close();
});
