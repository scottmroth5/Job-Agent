import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttp, RateLimitedError, HttpError } from '../tools/http.js';
import { htmlToText, extractJobPosting, decodeEntities } from '../tools/html.js';
import { keywordMatcher, detectJobType } from '../tools/titles.js';
import { checkLocation, matchesHome, statesIn, hasRemoteSignal } from '../tools/location.js';
import { openJobStore } from '../db/index.js';

// ---------- http ----------
const response = (status, text = '') => ({ status, url: '', text: async () => text });

test('http retries once on 5xx and network errors, then succeeds', async () => {
  const calls = [];
  const replies = [new Error('socket hang up'), response(503), response(200, 'ok')];
  const http = createHttp({
    fetchImpl: async (url, init) => {
      calls.push(init.headers['User-Agent']);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    sleepImpl: async () => {},
  });
  await assert.rejects(http.get('https://a.example.com/x', { retries: 0 }), /socket hang up/);
  assert.equal((await http.get('https://a.example.com/x')).text, 'ok');
  assert.ok(calls.every((ua) => ua.includes('Mozilla')));
});

test('http reports 429 and other errors distinctly', async () => {
  const http = (status) => createHttp({ fetchImpl: async () => response(status), sleepImpl: async () => {} });
  await assert.rejects(http(429).get('https://b.example.com/'), RateLimitedError);
  await assert.rejects(http(404).get('https://b.example.com/'), (e) => e instanceof HttpError && e.status === 404);
});

// ---------- html ----------
test('htmlToText keeps structure and drops scripts', () => {
  const html = '<head><title>x</title></head><script>var a=1</script><h2>About</h2><p>We build&nbsp;things &amp; more.</p><ul><li>One</li><li>Two</li></ul>';
  assert.equal(htmlToText(html), 'About\nWe build things & more.\n- One\n- Two');
  assert.equal(decodeEntities('&#39;a&#x27;&quot;'), '\'a\'"');
});

test('extractJobPosting reads JSON-LD, including @graph and HTML descriptions', () => {
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', name: 'Not it' },
      {
        '@type': 'JobPosting',
        title: 'VP of Engineering',
        hiringOrganization: { '@type': 'Organization', name: 'Example Co' },
        description: '&lt;p&gt;Lead the team.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Scale&lt;/li&gt;&lt;/ul&gt;',
        datePosted: '2026-09-20',
        jobLocationType: 'TELECOMMUTE',
        jobLocation: [{ address: { addressLocality: 'Springfield', addressRegion: 'IL' } }],
        employmentType: ['FULL_TIME'],
        baseSalary: { value: { minValue: 200000, maxValue: 250000 } },
      },
    ],
  };
  const html = `<html><script type="application/ld+json">${JSON.stringify(ld)}</script></html>`;
  assert.deepEqual(extractJobPosting(html), {
    title: 'VP of Engineering',
    company: 'Example Co',
    description: 'Lead the team.\n- Scale',
    datePosted: '2026-09-20',
    location: 'Springfield, IL',
    remote: true,
    employmentType: 'FULL_TIME',
    salary: '$200k - $250k',
  });
  assert.equal(extractJobPosting('<script type="application/ld+json">{bad json</script>'), null);
});

// ---------- titles ----------
test('keyword matching is whole-word, fixing the v1 "cto" in "director" bug', () => {
  const relevant = keywordMatcher(['cto', 'vp', 'director of engineering', 'head of engineering']);
  assert.ok(relevant('CTO / Co-founder'));
  assert.ok(relevant('VP, Platform'));
  assert.ok(relevant('Senior Director of Engineering'));
  assert.ok(!relevant('Director of Sales'));
  assert.ok(!relevant('VPN Network Engineer'));
  assert.ok(!keywordMatcher([])('anything'));
  assert.equal(detectJobType('Fractional CTO'), 'Fractional');
  assert.equal(detectJobType('VP Engineering', 'This is a full-time role'), 'Full-time');
  assert.equal(detectJobType('VP Engineering'), null);
});

// ---------- location ----------
const HOME = ['Portland Metro Area', 'Portland, OR', 'Beaverton, OR', 'Vancouver, WA'];

test('statesIn reads codes and names but not lowercase words', () => {
  assert.deepEqual([...statesIn('Portland, OR')], ['OR']);
  assert.deepEqual([...statesIn('Augusta, Maine')], ['ME']);
  assert.deepEqual([...statesIn('work in or near the office')], []);
});

test('matchesHome requires the state to match when one is named', () => {
  assert.ok(matchesHome('Beaverton, OR', HOME));
  assert.ok(matchesHome('Portland, Oregon, United States', HOME));
  assert.ok(matchesHome('Greater Portland Metro Area', HOME));
  assert.ok(matchesHome('Beaverton', HOME), 'no state named, city alone matches');
  assert.ok(!matchesHome('Portland, ME', HOME));
  assert.ok(matchesHome('Vancouver, BC, Canada', ['Vancouver, WA']), 'no US state named, so the city match counts (known edge)');
  assert.ok(matchesHome('Seattle, WA; Beaverton, OR', HOME), 'one of several places matches');
});

test('checkLocation classifies each case', () => {
  assert.equal(checkLocation({ location: 'Newark, NJ', workplace: 'remote' }, HOME), 'remote');
  assert.equal(checkLocation({ location: 'Remote (unconfirmed)' }, HOME), 'unverified');
  assert.equal(checkLocation({ location: 'Remote, US' }, HOME), 'remote');
  assert.equal(checkLocation({ location: 'Beaverton, OR' }, HOME), 'home');
  assert.equal(checkLocation({ location: 'United States' }, HOME), 'unknown');
  assert.equal(checkLocation({ location: '' }, HOME), 'unknown');
  assert.equal(checkLocation({ location: 'Portland, ME' }, HOME), 'conflict');
  assert.equal(checkLocation({ location: 'Austin, TX', text: 'This role is open to remote candidates.' }, HOME), 'remote_signal');
  assert.equal(checkLocation({ location: 'Austin, TX', text: 'We build remote patient monitoring.' }, HOME), 'conflict');
  assert.ok(hasRemoteSignal('Fully remote within the US'));
});

// ---------- migration ----------
test('002 migration adds discovery columns and sightings', () => {
  const store = openJobStore(':memory:');
  const cols = store.db.prepare('PRAGMA table_info(postings)').all().map((c) => c.name);
  for (const c of ['workplace', 'location_check', 'fetch_method', 'source_job_id']) assert.ok(cols.includes(c), c);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
  assert.ok(tables.includes('posting_sightings'));
  store.close();
});
