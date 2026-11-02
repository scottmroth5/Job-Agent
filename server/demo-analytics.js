// The public demo's usage counts, sent to PostHog: which screens and sample features visitors try. Only the demo
// (AUTH_MODE=demo) ever has a configuration, so the app itself sends nothing to anyone. The browser builds every
// event from fixed names and values (web/src/analytics.js); /api/me hands it the project key and host, and the
// page's Content-Security-Policy lets it reach that host and no other.
import { hostIs } from '../tools/urls.js';

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * { key, host } from DEMO_POSTHOG_KEY (a project key, phc_..., meant for browser code) and DEMO_POSTHOG_HOST
 * (default the US cloud), or null: outside the demo, with no key, or with anything but an https posthog.com host.
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
  return { key, host: url.origin };
}
