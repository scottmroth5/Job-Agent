// The public demo's usage counts (server/demo-analytics.ts, web/src/analytics.js): only the demo is ever configured,
// the page may reach the PostHog host and nothing else, and every event carries fixed names and values only.
// A made-up key; no network (fetch is replaced).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.ts';
import { buildApp } from '../server/app.ts';
import { authSettings } from '../server/auth.ts';
import { demoAnalytics } from '../server/demo-analytics.ts';
import { CONTENT_SECURITY_POLICY } from '../server/security.ts';
import { SECTIONS, SOURCES, changeFeature, eventBody, sampled, startAnalytics, track, trafficSource } from '../web/src/analytics.js';
import { DEMO_CONFIG } from '../demo/sample-data.ts';

const KEY = 'phc_ExampleKey0123456789abcdefABCDEF';
const DEMO_ENV = { AUTH_MODE: 'demo', PUBLIC_URL: 'https://demo.example.com', DEMO_POSTHOG_KEY: KEY };

test('only the demo, with a project key and an https posthog.com host, is configured', () => {
  assert.deepEqual(demoAnalytics(DEMO_ENV), { key: KEY, host: 'https://us.i.posthog.com', site: 'example.com' });
  assert.deepEqual(demoAnalytics({ ...DEMO_ENV, DEMO_POSTHOG_HOST: 'https://eu.i.posthog.com/' }), { key: KEY, host: 'https://eu.i.posthog.com', site: 'example.com' });
  assert.equal(demoAnalytics({ ...DEMO_ENV, AUTH_MODE: 'google' }), null);
  assert.equal(demoAnalytics({ ...DEMO_ENV, AUTH_MODE: undefined }), null);
  assert.equal(demoAnalytics({ ...DEMO_ENV, DEMO_POSTHOG_KEY: '' }), null);
  assert.equal(demoAnalytics({ ...DEMO_ENV, DEMO_POSTHOG_KEY: 'phx_personalApiKey0123456789abcdef' }), null);
  assert.equal(demoAnalytics({ ...DEMO_ENV, DEMO_POSTHOG_HOST: 'http://us.i.posthog.com' }), null);
  assert.equal(demoAnalytics({ ...DEMO_ENV, DEMO_POSTHOG_HOST: 'https://evil-posthog.com' }), null);
});

async function appFor(authMode, env) {
  const store = openJobStore(':memory:');
  const webDir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Job Hunt</title>');
  return buildApp({ store, config: DEMO_CONFIG, webDir, authMode, auth: { settings: authSettings(env) }, services: { log: { info() {}, warn() {}, error() {} } } });
}

test('the demo hands the page its key and lets it reach the host; the app does neither', async () => {
  const demo = await appFor('demo', DEMO_ENV);
  const me = await demo.inject({ method: 'GET', url: '/api/me' });
  assert.deepEqual(me.json().analytics, { key: KEY, host: 'https://us.i.posthog.com', site: 'example.com' });
  assert.match(me.headers['content-security-policy'], /connect-src 'self' https:\/\/us\.i\.posthog\.com;/);
  assert.match(me.headers['content-security-policy'], /script-src 'self';/);
  await demo.close();

  const unset = await appFor('demo', { ...DEMO_ENV, DEMO_POSTHOG_KEY: '' });
  const meUnset = await unset.inject({ method: 'GET', url: '/api/me' });
  assert.equal(meUnset.json().analytics, null);
  assert.equal(meUnset.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
  await unset.close();

  // The local app with the variables set by mistake: nothing.
  const app = await appFor('none', { ...DEMO_ENV, AUTH_MODE: 'none' });
  const meApp = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(meApp.json().analytics, undefined);
  assert.equal(meApp.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
  await app.close();
});

test('an event carries only its fixed properties, and anything off the lists is dropped', () => {
  const at = { key: KEY, id: 'anon-1', now: new Date('2026-11-02T12:00:00Z') };
  assert.deepEqual(eventBody('section_viewed', { section: 'jobs' }, at), {
    api_key: KEY,
    event: 'section_viewed',
    distinct_id: 'anon-1',
    properties: { app: 'job_hunt_demo', section: 'jobs', $process_person_profile: false },
    timestamp: '2026-11-02T12:00:00.000Z',
  });
  // Extra properties never ride along.
  assert.deepEqual(eventBody('job_viewed', { id: 42, title: 'VP Engineering', url: 'https://x' }, at).properties, { app: 'job_hunt_demo', $process_person_profile: false });
  assert.equal(eventBody('section_viewed', { section: 'jobs/42' }, at), null);
  assert.equal(eventBody('section_viewed', {}, at), null);
  assert.equal(eventBody('typed_text', { text: 'hello' }, at), null);
  assert.equal(eventBody('feature_failed', { feature: 'cover_letter', error_category: 'TypeError: x is undefined' }, at), null);
  assert.ok(eventBody('feature_failed', { feature: 'cover_letter', error_category: 'unexpected' }, at));
  assert.ok(eventBody('fit_evaluation_completed', {}, at));
  for (const section of SECTIONS) assert.ok(eventBody('section_viewed', { section }, at));
});

test('a stopped change is named by its kind, never its path', () => {
  assert.equal(changeFeature('PATCH', '/api/postings/12'), 'job_update');
  assert.equal(changeFeature('POST', '/api/postings'), 'job_add');
  assert.equal(changeFeature('POST', '/api/postings/12/notes'), 'note');
  assert.equal(changeFeature('DELETE', '/api/notes/7'), 'note');
  assert.equal(changeFeature('POST', '/api/postings/12/letter'), 'cover_letter');
  assert.equal(changeFeature('POST', '/api/postings/12/actions/refetch'), 'job_action');
  assert.equal(changeFeature('PUT', '/api/account/profile'), 'settings');
  assert.equal(changeFeature('POST', '/api/pipeline/run'), 'pipeline');
  assert.equal(changeFeature('POST', '/api/something-new?x=secret'), 'other');
});

// The browser's Global Privacy Control signal, set for the length of fn.
async function withPrivacyControl(on, fn) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { globalPrivacyControl: on }, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (before) Object.defineProperty(globalThis, 'navigator', before);
    else delete globalThis.navigator;
  }
}

// The page's address and referrer (location, document), set for the length of fn.
async function withPage(href, referrer, fn) {
  const saved = ['location', 'document'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, 'location', { value: { href, hostname: new URL(href).hostname }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: { referrer }, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    for (const [name, before] of saved) {
      if (before) Object.defineProperty(globalThis, name, before);
      else delete globalThis[name];
    }
  }
}

test('the traffic source is one of five categories, from a listed utm_source or the referrer host', () => {
  const page = 'https://demo.example.com/#/';
  const own = 'demo.example.com';
  const site = 'example.org';
  const from = (referrer, { url = page, withSite = true } = {}) => trafficSource({ url, referrer, ownHost: own, site: withSite ? site : undefined });

  // utm_source first, only when it is on the list.
  assert.equal(from('', { url: 'https://demo.example.com/?utm_source=linkedin#/' }), 'linkedin');
  assert.equal(from('', { url: 'https://demo.example.com/?utm_source=LinkedIn' }), 'linkedin');
  assert.equal(from('', { url: 'https://demo.example.com/?utm_source=github' }), 'github');
  assert.equal(from('', { url: 'https://demo.example.com/?utm_source=example' }), 'personal_site');
  // A spoofed or unknown utm_source falls through to the referrer.
  assert.equal(from('', { url: 'https://demo.example.com/?utm_source=evil' }), 'direct');
  assert.equal(from('https://www.linkedin.com/', { url: 'https://demo.example.com/?utm_source=<script>' }), 'linkedin');
  assert.equal(from('', { url: 'https://demo.example.com/?utm_source=personal_site' }), 'direct');
  assert.equal(from('', { url: 'https://demo.example.com/?utm_source=example', withSite: false }), 'direct');

  // Referrer hosts.
  assert.equal(from('https://linkedin.com/in/someone'), 'linkedin');
  assert.equal(from('https://www.linkedin.com/feed/'), 'linkedin');
  assert.equal(from('https://lnkd.in/abc123'), 'linkedin');
  assert.equal(from('https://github.com/someone/repo'), 'github');
  assert.equal(from('https://example.org/projects'), 'personal_site');
  assert.equal(from('https://blog.example.org/post'), 'personal_site');
  assert.equal(from('https://demo.example.com/#/jobs'), 'direct');
  assert.equal(from(''), 'direct');
  assert.equal(from(undefined), 'direct');
  assert.equal(from('https://news.example.net/'), 'other');

  // Lookalike hosts, a malformed referrer, and the personal site with no setting are other.
  assert.equal(from('https://linkedin.com.example.com/'), 'other');
  assert.equal(from('https://notlinkedin.com/'), 'other');
  assert.equal(from('https://notgithub.com/'), 'other');
  assert.equal(from('https://github.com.evil.test/'), 'other');
  assert.equal(from('https://example.org.evil.test/'), 'other');
  assert.equal(from('not a url'), 'other');
  assert.equal(from('https://example.org/', { withSite: false }), 'other');

  // Every answer is on the list.
  for (const v of ['linkedin', 'github', 'personal_site', 'other', 'direct']) assert.ok(SOURCES.includes(v));
  assert.equal(SOURCES.length, 5);
});

test('demo_opened carries only a listed source', () => {
  const at = { key: KEY, id: 'anon-1' };
  for (const source of SOURCES) assert.equal(eventBody('demo_opened', { source }, at).properties.source, source);
  assert.equal(eventBody('demo_opened', { source: 'https://www.linkedin.com/feed/' }, at), null);
  assert.equal(eventBody('demo_opened', { source: 'example' }, at), null);
  assert.equal(eventBody('demo_opened', {}, at), null);
});

test('the personal site is the domain above the demo address', () => {
  assert.equal(demoAnalytics(DEMO_ENV).site, 'example.com');
  assert.equal(demoAnalytics({ ...DEMO_ENV, PUBLIC_URL: 'https://Demo.Jobs.Example.ORG/' }).site, 'jobs.example.org');
  for (const none of ['http://localhost:5180', 'https://example.com', 'http://127.0.0.1:5180', 'not a url', undefined])
    assert.equal('site' in demoAnalytics({ ...DEMO_ENV, PUBLIC_URL: none }), false, String(none));
});

test('Global Privacy Control: nothing is sent, not even demo_opened (runs before anything starts)', async (t) => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    sent.push(url);
    return new Response('{}');
  });
  await withPrivacyControl(true, async () => {
    startAnalytics({ key: KEY, host: 'https://us.i.posthog.com' });
    track('section_viewed', { section: 'jobs' });
    await sampled('cover_letter', async () => 'ok');
  });
  assert.deepEqual(sent, []);
});

test('sending: nothing before start, then only listed events, with no credentials or referrer', async (t) => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return new Response('{}');
  });
  track('section_viewed', { section: 'jobs' });
  assert.equal(sent.length, 0);

  startAnalytics({ key: 'not a key', host: 'https://us.i.posthog.com' });
  assert.equal(sent.length, 0);
  // The page's address and referrer decide the source; neither is sent.
  await withPage('https://demo.example.com/?utm_source=linkedin&utm_campaign=secret-campaign#/jobs', 'https://www.linkedin.com/feed/secret-post', () =>
    startAnalytics({ key: KEY, host: 'https://us.i.posthog.com', site: 'example.org' }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://us.i.posthog.com/i/v0/e/');
  assert.equal(sent[0].body.event, 'demo_opened');
  assert.deepEqual(sent[0].body.properties, { app: 'job_hunt_demo', source: 'linkedin', $process_person_profile: false });
  assert.doesNotMatch(JSON.stringify(sent[0].body), /secret|example\.(com|org)|utm|feed/);
  assert.equal(sent[0].init.credentials, 'omit');
  assert.equal(sent[0].init.referrerPolicy, 'no-referrer');

  track('section_viewed', { section: 'secret search words' });
  assert.equal(sent.length, 1);

  await sampled('cover_letter', async () => 'ok');
  await assert.rejects(sampled('meeting_prep', async () => {
    throw new Error('Cannot reach the Job Agent server. Start it with npm run ui, then try again.');
  }));
  assert.deepEqual(sent.slice(1).map((s) => [s.body.event, s.body.properties.feature ?? null, s.body.properties.error_category ?? null]), [
    ['cover_letter_started', null, null],
    ['cover_letter_completed', null, null],
    ['meeting_prep_started', null, null],
    ['feature_failed', 'meeting_prep', 'network'],
  ]);
  // One anonymous id for the page; every body holds only the expected keys.
  assert.equal(new Set(sent.map((s) => s.body.distinct_id)).size, 1);
  for (const { body } of sent) assert.deepEqual(Object.keys(body).sort(), ['api_key', 'distinct_id', 'event', 'properties', 'timestamp']);

  // Turning Global Privacy Control on mid-visit stops sending at once.
  const count = sent.length;
  await withPrivacyControl(true, () => track('job_viewed'));
  assert.equal(sent.length, count);
  await withPrivacyControl(false, () => track('job_viewed'));
  assert.equal(sent.length, count + 1);

  // A failing request never reaches the page.
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('blocked');
  });
  assert.doesNotThrow(() => track('job_viewed'));
});
