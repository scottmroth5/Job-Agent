// The public demo's usage counts, sent to PostHog: which screens and sample features visitors try. Only the demo
// (AUTH_MODE=demo) ever has a configuration, so the app itself sends nothing to anyone. The browser builds every
// event from fixed names and values (web/src/analytics.js); /api/me hands it the project key and host, and the
// page's Content-Security-Policy lets it reach that host and no other.
import { hostIs } from '../tools/urls.js';

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * { key, host } from DEMO_POSTHOG_KEY (a project key, phc_..., meant for browser code) and DEMO_POSTHOG_HOST
 * (default the US cloud), or null: outside the demo, with no key, or with anything but an https posthog.com host.
 * DEMO_SOURCE_SITE (a bare hostname, optional) adds site: the personal site counted as the personal_site source.
 * It lives in .env, never the repo; the page only compares hostnames with it and never fetches it.
 */
export function demoAnalytics(env = process.env) {
  if (env.AUTH_MODE !== 'demo') return null;
  const key = String(env.DEMO_POSTHOG_KEY || '').trim();
  if (!/^phc_[A-Za-z0-9]{20,80}$/.test(key)) return null;
  let url;
  try {
    url = new URL(env.DEMO_POSTHOG_HOST || DEFAULT_POSTHOG_HOST);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !hostIs(url.hostname, 'posthog.com')) return null;
  const site = String(env.DEMO_SOURCE_SITE || '').trim().toLowerCase();
  return { key, host: url.origin, ...(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site) ? { site } : {}) };
}
