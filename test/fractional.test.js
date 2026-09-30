import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fractionaljobs from '../agents/discovery/sources/fractionaljobs.js';
import { buildQueries, GO_FRACTIONAL } from '../agents/discovery/sources/serper.js';
import { resolveDetails } from '../agents/discovery/details.js';
import { runDiscovery } from '../agents/discovery/discover.js';
import { openJobStore } from '../db/index.js';

// Made-up listings in the real markup shape.
const card = ({ slug, company, title, hours, rate, location, date }) => `
  <div role="listitem" class="job-item w-dyn-item"><div class="job-item_flex"><div class="job-item_name_url">
    <h3 class="text-size-regular text-inline">${company}</h3><h3 class="text-size-regular text-inline">-</h3>
    <h3 class="text-size-regular text-inline">${title}</h3>
    <div class="text-inline w-condition-invisible">(</div><a href="#" class="job-item_company-link w-inline-block w-condition-invisible"></a>
    <div class="text-inline w-condition-invisible">)</div></div>
    <a href="/jobs/${slug}" class="job-item_link-to-job w-inline-block"></a>
    <div class="job-item_more-info"><div class="text-inline">${hours}</div><div class="text-inline">|</div>
    <div class="text-inline">${rate}</div><div class="text-inline">|</div><div class="text-inline">${location}</div></div>
    <div class="date">${date}</div><div class="job-item_date"><div class="text-inline">added</div><div class="post-date text-inline">${date}</div></div>
  </div></div>`;

const LISTING = `<html>${card({ slug: 'fractional-cto-at-a-demo-startup', company: 'A Demo Startup', title: 'Fractional CTO', hours: '10 - 15 hrs', rate: '$150 - $200 / hr', location: 'Remote (USA only)', date: 'September 28, 2026' })}
${card({ slug: 'chief-information-security-officer-at-a-demo-league', company: 'A Demo League', title: 'Chief Information Security Officer', hours: '5 - 10 hrs', rate: '$200 - $250 / hr', location: 'Remote (USA / Canada only)', date: 'September 29, 2026' })}
${card({ slug: 'bookkeeper-at-a-demo-shop', company: 'A Demo Shop', title: 'Bookkeeper', hours: '5 hrs', rate: '$40 / hr', location: 'Remote', date: 'September 29, 2026' })}</html>`;

const JOB_PAGE = `<h1>Fractional CTO</h1><div class="text-rich-text w-richtext"><p>${'We need an experienced technology leader to harden production. '.repeat(6)}</p><ul><li>Own the roadmap</li></ul></div>
  <div>Weekly Commitment</div><div>10 - 15 hrs</div><div>Compensation Range</div><div>$150 - $200 / hr</div>
  <div>Company Stage</div><div>Seed</div><div>Industry</div><div>Analytics</div><div>Location</div><div>Remote (USA only)</div>
  <div>convert full-time</div>`;

test('parseListing reads company, title, hours, pay, location and date from each card', () => {
  const items = fractionaljobs.parseListing(LISTING);
  assert.equal(items.length, 3);
  const [cto] = items;
  assert.deepEqual(
    { company: cto.company, title: cto.title, hoursText: cto.hoursText, rateText: cto.rateText, location: cto.location, postedOn: cto.postedOn, workplace: cto.workplace, url: cto.url },
    { company: 'A Demo Startup', title: 'Fractional CTO', hoursText: '10 - 15 hrs', rateText: '$150 - $200 / hr', location: 'Remote (USA only)', postedOn: '2026-09-28', workplace: 'remote', url: 'https://www.fractionaljobs.io/jobs/fractional-cto-at-a-demo-startup' },
  );
  assert.deepEqual(cto.rate, { min: 150, max: 200, unit: 'hour' });
  assert.deepEqual(cto.hours, { min: 10, max: 15 });
  assert.equal(cto.searchTrack, 'fractional');
});

test('parsePosting reads the description and labeled terms; details use it', async () => {
  const p = fractionaljobs.parsePosting(JOB_PAGE);
  assert.match(p.description, /harden production/);
  assert.match(p.description, /- Own the roadmap/);
  assert.equal(p.hoursText, '10 - 15 hrs');
  assert.equal(p.rateText, '$150 - $200 / hr');
  assert.deepEqual(p.extra, { companyStage: 'Seed', industry: 'Analytics', notes: ['convert full-time'] });

  const [item] = fractionaljobs.parseListing(LISTING);
  const http = { get: async () => ({ status: 200, text: JOB_PAGE }), sleep: async () => {} };
  await resolveDetails(item, { http });
  assert.deepEqual([item.fetchStatus, item.fetchMethod], ['ok', 'source-page']);
  assert.equal(item.extra.industry, 'Analytics');
});

test('Serper queries include fractional terms and a Go Fractional site search', () => {
  assert.equal(buildQueries({ search: { terms: ['CTO'], fractionalTerms: ['Fractional CTO'] } }).length, 2, 'site search is off by default');
  const queries = buildQueries({ search: { terms: ['CTO'], fractionalTerms: ['Fractional CTO'], siteSearch: true } });
  assert.deepEqual(queries, [
    { term: 'CTO', q: 'CTO remote jobs' },
    { term: 'Fractional CTO', q: 'Fractional CTO remote', searchTrack: 'fractional' },
    { term: 'Fractional CTO', q: 'site:gofractional.com/jobs Fractional CTO', searchTrack: 'fractional', source: GO_FRACTIONAL },
  ]);
  assert.equal(buildQueries({ search: { terms: ['CTO'] } }).length, 1);
});

test('discovery stores fractional postings with track, pay, hours and extras; fractional keywords pass CISO titles', async () => {
  const store = openJobStore(':memory:');
  const config = {
    search: {
      terms: ['CTO'],
      relevantTitleKeywords: ['cto', 'vp'],
      fractionalTitleKeywords: ['fractional', 'chief information security'],
      noiseTitleKeywords: [],
      homeLocations: ['Anytown, ST'],
    },
  };
  const http = { get: async () => ({ status: 200, text: JOB_PAGE }), sleep: async () => {} };
  const sources = {
    fractionaljobs: { SOURCE: 'Fractional Jobs', search: async () => ({ items: fractionaljobs.parseListing(LISTING), requests: 1, errors: [], rateLimited: false }) },
  };
  const summary = await runDiscovery({ store, config, http, sources, now: new Date('2026-09-30T12:00:00Z'), options: { pauseMs: 0, linkedinPauseMs: 0 } });
  assert.equal(summary.inserted, 2, 'the bookkeeper role is not relevant');
  const rows = store.db.prepare('SELECT title, track, rate_text, rate_min, rate_max, rate_unit, hours_min, hours_max, extra_json, location_check FROM postings ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.title, r.track, r.rate_unit, r.hours_max, r.location_check]), [
    ['Fractional CTO', 'fractional', 'hour', 15, 'remote'],
    ['Chief Information Security Officer', 'fractional', 'hour', 10, 'remote'],
  ]);
  assert.equal(JSON.parse(rows[0].extra_json).companyStage, 'Seed');
  store.close();
});
