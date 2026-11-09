// The public demo's usage counts, sent to PostHog: which screens and sample features visitors try. Only the demo
// (AUTH_MODE=demo) ever has a configuration, so the app itself sends nothing to anyone. The browser builds every
// event from fixed names and values (web/src/analytics.ts); /api/me hands it the project key and host, and the
// page's Content-Security-Policy lets it reach that host and no other.
import { hostIs } from '../tools/urls.ts';

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * { key, host } from DEMO_POSTHOG_KEY (a project key, phc_..., meant for browser code) and DEMO_POSTHOG_HOST
 * (default the US cloud), or null: outside the demo, with no key, or with anything but an https posthog.com host.
 * It adds site, the site counted as the personal_site source: the parent domain of the demo's own address
 * (PUBLIC_URL, from DEMO_SITE_ADDRESS; demo.example.com gives example.com), so it is never written in the repo.
 * The page only compares hostnames with it and never fetches it.
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
  const site = parentSite(env.PUBLIC_URL);
  return { key, host: url.origin, ...(site ? { site } : {}) };
}

/** The domain above an address's host (demo.example.com gives example.com), or null without one (localhost, an IP). */
function parentSite(publicUrl: string | undefined) {
  let host;
  try {
    host = new URL(publicUrl ?? '').hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split('.');
  if (labels.length < 3 || labels.every((l) => /^\d+$/.test(l))) return null;
  return labels.slice(1).join('.');
}
