// The public demo's usage counts (server/demo-analytics.js, web/src/analytics.js): only the demo is ever configured,
// the page may reach the PostHog host and nothing else, and every event carries fixed names and values only.
// A made-up key; no network (fetch is replaced).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { demoAnalytics } from '../server/demo-analytics.js';
import { CONTENT_SECURITY_POLICY } from '../server/security.js';
import { SECTIONS, changeFeature, eventBody, sampled, startAnalytics, track } from '../web/src/analytics.js';
import { DEMO_CONFIG } from '../demo/sample-data.js';

const KEY = 'phc_ExampleKey0123456789abcdefABCDEF';
const DEMO_ENV = { AUTH_MODE: 'demo', PUBLIC_URL: 'https://demo.example.com', DEMO_POSTHOG_KEY: KEY };

test('only the demo, with a project key and an https posthog.com host, is configured', () => {
  assert.deepEqual(demoAnalytics(DEMO_ENV), { key: KEY, host: 'https://us.i.posthog.com' });
  assert.deepEqual(demoAnalytics({ ...DEMO_ENV, DEMO_POSTHOG_HOST: 'https://eu.i.posthog.com/' }), { key: KEY, host: 'https://eu.i.posthog.com' });
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
  assert.deepEqual(me.json().analytics, { key: KEY, host: 'https://us.i.posthog.com' });
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
  startAnalytics({ key: KEY, host: 'https://us.i.posthog.com' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://us.i.posthog.com/i/v0/e/');
  assert.equal(sent[0].body.event, 'demo_opened');
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
