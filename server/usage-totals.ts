// The admin's usage totals (Admin > Usage): app-wide counts per day of visits by device type, by browser and major
// version, and by approximate location, and of arrivals by a general source. Signed-in app only (AUTH_MODE=google); the demo, local runs,
// scheduled jobs, and the pipeline count nothing.
// - A visit: the first successful request of the day from a signed-in browser (the page or an API call, never a
//   static file, the health check, or a refused request), once per account per app day. The accounts already counted
//   today are an in-memory set, cleared when the day changes and never written anywhere; a restart may count someone
//   twice. The device type and browser come from the user agent and the location from the address, looked up in the local
//   database (server/geo.ts, never an outside service).
// - An arrival: a page load of the app's main page (signed in or on its way to sign-in) or a direct link to sign-in,
//   from outside the app, as one fixed source category.
// The address, user agent, Referer, and URL are read here and dropped: usage_totals (migrations 020, 021) holds only
// the day, the dimension, a fixed value ("Chrome 130" is a fixed name and a number) or "City, State, Country", and a
// count. Nothing is logged.
import { isPrivateAddress } from './geo.ts';
import { appDay } from '../tools/dates.ts';
import { hostIs } from '../tools/urls.ts';
import type { IncomingHttpHeaders } from 'node:http';
import type { Db } from '../tools/types.ts';
import type { App } from './types.ts';

/** An approximate location (server/geo.ts openGeo): any part may be missing. */
export type Place = { city?: string | null; state?: string | null; country?: string | null };
/** The parts of a request these counts read. */
type CountedRequest = { method: string; url: string; headers: IncomingHttpHeaders; uid?: number; ip?: string };

export const DEVICES = ['phone', 'tablet', 'computer'];
export const SOURCES = ['linkedin', 'github', 'site', 'demo', 'other', 'direct'];
const UTM_SOURCES = new Set(['linkedin', 'github', 'site', 'demo']);
// Returning from Google's sign-in is never a source: it is classified so it can be left out.
export const GOOGLE_SIGNIN_RETURN = 'google_signin_return';

/** A bare hostname from a setting (SOURCE_SITE_HOST, SOURCE_DEMO_HOST), or null. */
export const hostSetting = (v: string | null | undefined) => {
  const h = String(v ?? '').trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : null;
};

/** phone, tablet, or computer, from the request headers (the user agent, and the mobile client hint). */
export function deviceOf(headers: IncomingHttpHeaders = {}) {
  const ua = String(headers['user-agent'] ?? '');
  if (headers['sec-ch-ua-mobile'] === '?1') return 'phone';
  if (/iPad|Tablet|PlayBook|Kindle|Silk/i.test(ua)) return 'tablet';
  if (/iPhone|iPod|Windows Phone|Mobi/i.test(ua)) return 'phone';
  if (/Android/i.test(ua)) return 'tablet'; // Android without "Mobile"
  return 'computer';
}

// Browsers by the token their user agent carries, most specific first (Edge, Opera, and Samsung also say Chrome and
// Safari; Chrome on iPhone says Safari). The version is the major number only.
const BROWSERS: Array<[string, RegExp]> = [
  ['Edge', /\bEdg(?:e|A|iOS)?\/(\d{1,3})/],
  ['Opera', /\b(?:OPR|OPiOS)\/(\d{1,3})/],
  ['Samsung Internet', /\bSamsungBrowser\/(\d{1,3})/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d{1,3})/],
  ['Chrome', /\b(?:Chrome|CriOS)\/(\d{1,3})/],
  ['Safari', /\bVersion\/(\d{1,3})(?:\.\d+)*(?: Mobile\/\w+)? Safari\//],
];
export const BROWSER_NAMES = BROWSERS.map(([name]) => name);

/** Browser and major version ("Chrome 130"), or "Other": a fixed name and a number, never the user agent's text. */
export function browserOf(headers: IncomingHttpHeaders = {}) {
  const ua = String(headers['user-agent'] ?? '');
  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua);
    if (m) return `${name} ${Number(m[1])}`;
  }
  return 'Other';
}

/** "City, State, Country" from a lookup ({ city, state, country }), or "unknown" without a country. */
export function locationValue(loc: Place | null | undefined) {
  const part = (s: string | null | undefined) => String(s ?? '').replace(/[,\s]+/g, ' ').trim();
  if (!loc || !part(loc.country)) return 'unknown';
  return `${part(loc.city) || 'Unknown'}, ${part(loc.state) || 'Unknown'}, ${part(loc.country)}`;
}

/**
 * Where an arrival came from: one of SOURCES, GOOGLE_SIGNIN_RETURN (never stored), or null when the Referer is the
 * app itself (internal navigation, not an arrival). Google's sign-in comes first, since its return carries the
 * original address (and any utm_source) back; then a listed utm_source; then the Referer's whole hostname.
 */
export function sourceOf({
  referer,
  url,
  ownOrigin,
  siteHost,
  demoHost,
}: {
  referer?: string | null;
  url: string;
  ownOrigin?: string | null;
  siteHost?: string | null;
  demoHost?: string | null;
}) {
  let ref: URL | null = null;
  if (referer) {
    try {
      ref = new URL(referer);
    } catch {
      ref = null;
    }
  }
  if (ref && ownOrigin && ref.origin === ownOrigin) return null;
  const host = ref?.hostname.toLowerCase() ?? null;
  if (host && hostIs(host, 'accounts.google.com')) return GOOGLE_SIGNIN_RETURN;

  let utm: string | null = null;
  try {
    utm = new URL(url, 'http://x').searchParams.get('utm_source')?.toLowerCase() ?? null;
  } catch {
    // No usable address: go by the Referer.
  }
  if (utm && UTM_SOURCES.has(utm)) return utm;

  if (!referer) return 'direct';
  if (!host) return 'other';
  if (hostIs(host, 'linkedin.com') || hostIs(host, 'lnkd.in')) return 'linkedin';
  if (host === 'github.com') return 'github';
  if (demoHost && host === demoHost) return 'demo';
  if (siteHost && hostIs(host, siteHost)) return 'site';
  return 'other';
}

const pathOf = (url: string | null | undefined) => String(url ?? '').split('?')[0];

/** A page load (not a script, image, or API call), by Sec-Fetch-Dest when the browser sends it, else Accept. */
const isDocument = (headers: IncomingHttpHeaders) => (headers['sec-fetch-dest'] ? headers['sec-fetch-dest'] === 'document' : /text\/html/.test(String(headers.accept ?? '')));

/**
 * Whether a response is an arrival: a page load of the main page (200, or the redirect to sign-in) or a direct link to
 * sign-in. /auth/login?next= is the second step of an arrival at the main page, already counted.
 */
export function isArrival(req: CountedRequest, statusCode: number) {
  if (req.method !== 'GET' || statusCode >= 400 || !isDocument(req.headers)) return false;
  const path = pathOf(req.url);
  if (path === '/' || path === '/index.html') return true;
  if (path === '/auth/login') return !new URL(req.url, 'http://x').searchParams.has('next');
  return false;
}

/**
 * Whether a response is a signed-in browser's use of the app (the page or an API call). Every browser's user agent
 * starts "Mozilla/"; a script's (curl, node, a test client) does not.
 */
const isVisit = (req: CountedRequest, statusCode: number) => {
  if (!req.uid || statusCode >= 400 || !/^Mozilla\//.test(String(req.headers['user-agent'] ?? ''))) return false;
  const path = pathOf(req.url);
  return path === '/' || path === '/index.html' || path.startsWith('/api/');
};

/** Adds one to a day's total. */
export const addToTotal = async (db: Db, day: string, dimension: string, value: string) =>
  await db.prepare('INSERT INTO usage_totals (day, dimension, value, count) VALUES (?, ?, ?, 1) ON CONFLICT (day, dimension, value) DO UPDATE SET count = count + 1').run(day, dimension, value);

/**
 * Counts visits and arrivals after each response. db: the unscoped database (an app-wide table); location: ip ->
 * { city, state, country } | null (server/geo.ts), or none (every location unknown); ownOrigin: the app's origin.
 */
export function registerUsageTotals(
  app: App,
  {
    db,
    location = null,
    ownOrigin = null,
    siteHost = null,
    demoHost = null,
    now = () => new Date(),
  }: {
    db: Db;
    location?: ((ip: string) => Place | null) | null;
    ownOrigin?: string | null;
    siteHost?: string | null;
    demoHost?: string | null;
    now?: () => Date;
  },
) {
  const site = hostSetting(siteHost);
  const demo = hostSetting(demoHost);
  let counted: { day: string | null; ids: Set<number> } = { day: null, ids: new Set() };

  app.addHook('onResponse', async (req, reply) => {
    try {
      const day = appDay(now());
      if (isVisit(req, reply.statusCode)) {
        if (counted.day !== day) counted = { day, ids: new Set() };
        // A visit is signed in (isVisit), so req.uid is set.
        if (!counted.ids.has(req.uid as number)) {
          counted.ids.add(req.uid as number);
          let loc: Place | null = null;
          try {
            loc = req.ip && !isPrivateAddress(req.ip) && location ? location(req.ip) : null;
          } catch {
            loc = null;
          }
          await addToTotal(db, day, 'device', deviceOf(req.headers));
          await addToTotal(db, day, 'browser', browserOf(req.headers));
          await addToTotal(db, day, 'location', locationValue(loc));
        }
      }
      if (isArrival(req, reply.statusCode)) {
        const source = sourceOf({ referer: req.headers.referer, url: req.url, ownOrigin, siteHost: site, demoHost: demo });
        if (source && SOURCES.includes(source)) await addToTotal(db, day, 'source', source);
      }
    } catch {
      // Counting never affects a request.
    }
  });
}
