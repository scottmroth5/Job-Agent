// The public demo's usage counts, sent to PostHog (server/demo-analytics.js): which screens visitors open and which
// sample features they try, and where the visit came from as one of five fixed categories, never what they type or
// see. Every event is built here from fixed names and fixed property values; anything else is dropped before it is
// sent. No SDK, cookies, or storage: an anonymous id lives only as long as the page, and requests carry no referrer
// (the source is worked out here; the address, referrer, and utm text never leave the page). A browser sending
// Global Privacy Control gets nothing sent. Only the demo starts it (App, from /api/me), so the app itself sends
// nothing. A blocked or failing request never affects the page.
import { hostIs } from '../../tools/urls.ts';

// Screens (App's VIEWS plus home), the demo's sample AI features, and what a stopped change was about.
export const SECTIONS = ['home', 'jobs', 'inbox', 'funnel', 'activity', 'settings', 'help'];
export const FEATURES = ['fit_evaluation', 'cover_letter', 'letter_revision', 'meeting_prep', 'find_contact', 'help_answer', 'profile_draft'];
export const CHANGES = ['job_update', 'job_add', 'job_action', 'note', 'cover_letter', 'attachment', 'settings', 'inbox', 'pipeline', 'other'];
export const ERROR_CATEGORIES = ['network', 'unexpected'];
// Where a visit came from (trafficSource); personal_site is the domain above the demo's own address.
export const SOURCES = ['linkedin', 'github', 'personal_site', 'other', 'direct'];

// Each event and the only properties (with their allowed values) it may carry.
const EVENTS = {
  demo_opened: { source: SOURCES },
  section_viewed: { section: SECTIONS },
  job_viewed: {},
  change_blocked: { feature: CHANGES },
  feature_failed: { feature: FEATURES, error_category: ERROR_CATEGORIES },
  ...Object.fromEntries(FEATURES.flatMap((f) => [[`${f}_started`, {}], [`${f}_completed`, {}]])),
};

let target = null;
let distinctId = null;

const randomId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
};

/** Whether the browser sends Global Privacy Control: then the demo sends nothing at all. */
const privacyControlOn = () => {
  try {
    return globalThis.navigator?.globalPrivacyControl === true;
  } catch {
    return true;
  }
};

/** Starts sending for this page view: { key, host } from /api/me in the demo; anything else leaves it off. */
export function startAnalytics(config) {
  if (target || privacyControlOn() || !config || !/^phc_[A-Za-z0-9]+$/.test(config.key ?? '') || !/^https:\/\/[a-z0-9.-]+$/.test(config.host ?? '')) return;
  target = { key: config.key, url: `${config.host}/i/v0/e/` };
  distinctId = randomId();
  let source = 'other';
  try {
    source = trafficSource({ url: globalThis.location?.href, referrer: globalThis.document?.referrer, ownHost: globalThis.location?.hostname, site: config.site });
  } catch {
    // Unknown counts as other.
  }
  track('demo_opened', { source });
}

/**
 * Where a visit came from, as one of SOURCES: a utm_source of linkedin, github, or the personal site's first label
 * first, else the referrer's host (the demo's own host is direct, no referrer is direct, anything unknown is other).
 */
export function trafficSource({ url, referrer, ownHost, site } = {}) {
  const siteLabel = site ? site.split('.')[0] : null;
  let utm = null;
  try {
    utm = new URL(url).searchParams.get('utm_source')?.toLowerCase() ?? null;
  } catch {
    // No usable address: go by the referrer.
  }
  if (utm === 'linkedin' || utm === 'github') return utm;
  if (utm && utm === siteLabel) return 'personal_site';

  if (!referrer) return 'direct';
  let host;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (ownHost && host === String(ownHost).toLowerCase()) return 'direct';
  if (hostIs(host, 'linkedin.com') || hostIs(host, 'lnkd.in')) return 'linkedin';
  if (host === 'github.com') return 'github';
  if (site && hostIs(host, site)) return 'personal_site';
  return 'other';
}

/** The request body for an event, or null when the event or a property value is not on the lists above. */
export function eventBody(event, props = {}, { key, id, now = new Date() }) {
  const allowed = EVENTS[event];
  if (!allowed) return null;
  const properties = { app: 'job_hunt_demo' };
  for (const [name, values] of Object.entries(allowed)) {
    if (!values.includes(props[name])) return null;
    properties[name] = props[name];
  }
  // No person profile in PostHog: these are counts, not visitors.
  properties.$process_person_profile = false;
  return { api_key: key, event, distinct_id: id, properties, timestamp: now.toISOString() };
}

/** Sends one event (see EVENTS); does nothing before startAnalytics or for anything not on the lists. */
export function track(event, props) {
  try {
    if (!target || privacyControlOn()) return;
    const body = eventBody(event, props, { key: target.key, id: distinctId });
    if (!body) return;
    fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }).catch(() => {});
  } catch {
    // Analytics never breaks the demo.
  }
}

/** What a change the demo stopped was about, from its method and path (never the path itself). */
export function changeFeature(method, path) {
  const p = String(path ?? '').split('?')[0];
  if (/^\/api\/postings\/\d+\/notes|^\/api\/notes\//.test(p)) return 'note';
  if (/^\/api\/postings\/\d+\/letter/.test(p)) return 'cover_letter';
  if (/^\/api\/postings\/\d+\/attachments/.test(p)) return 'attachment';
  if (/^\/api\/postings\/\d+\/actions\//.test(p)) return 'job_action';
  if (/^\/api\/postings\/\d+$/.test(p)) return 'job_update';
  if (method === 'POST' && p === '/api/postings') return 'job_add';
  if (/^\/api\/(account|letter-header|excluded-sites|follow-ups\/settings|resumes|layout|prompts)(\/|$)/.test(p)) return 'settings';
  if (/^\/api\/inbox(\/|$)/.test(p)) return 'inbox';
  if (/^\/api\/pipeline(\/|$)/.test(p)) return 'pipeline';
  return 'other';
}

/** Runs a demo sample feature, counting its start, its completion (only on success), and a failure's category. */
export async function sampled(feature, run) {
  track(`${feature}_started`);
  try {
    const out = await run();
    track(`${feature}_completed`);
    return out;
  } catch (err) {
    track('feature_failed', { feature, error_category: /reach the Job Agent server/.test(err?.message ?? '') ? 'network' : 'unexpected' });
    throw err;
  }
}
