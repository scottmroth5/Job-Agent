// US-only access (owner's choice, 2026-10-25): requests from outside the allowed countries get a short 403 page, for the
// app and the demo. The health check (/healthz, used by the deploy and Docker) always passes, as do private and
// loopback addresses (inside the server). The country comes from DB-IP's free IP to City Lite database (CC BY 4.0,
// https://db-ip.com), downloaded into the image at build time (Dockerfile) and refreshed by the weekly rebuild; the
// same file gives the approximate city and state for the admin's usage totals (server/usage-totals.js). Lookups are
// local: no address ever goes to an outside service.
// GEO_ALLOW (comma-separated country codes) turns it on; unset, nothing is blocked (local runs, tests). Without the
// database it fails open and says so in the server log. An address the database does not know is let through: iPhones
// (iCloud Private Relay, new mobile IPv6 ranges) often arrive from such addresses, and blocking them locked out real
// users; only an address placed in another country is refused. Each refusal is logged with its country and a shortened
// address (the first half: a /24 or /48), never the full one, at most once an hour per shortened address.
// iCloud Private Relay (Safari, and home-screen web apps on iPhone) sends requests from Apple's relay partners' addresses,
// which DB-IP often places in the wrong country. Apple publishes those addresses with the country each one stands for
// (https://mask-api.icloud.com/egress-ip-ranges.csv, downloaded into the image next to DB-IP's file), so the country
// comes from that list first and from DB-IP only for addresses it does not list. A relay address Apple lists outside the
// allowed countries is still refused. Without the list, blocking stays on with DB-IP alone (server/index.js alerts).
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import maxmind from 'maxmind';

export const GEO_DB_PATH = process.env.GEO_DB || '/app/geo/city.mmdb';
export const RELAY_PATH = process.env.GEO_RELAY || '/app/geo/relay.csv';
const ALWAYS_OPEN = [/^\/healthz(\?|$)/];

/** The allowed country codes from GEO_ALLOW ("US", "US,CA"); empty when unset. */
export const geoAllowFromEnv = (env = process.env) =>
  String(env.GEO_ALLOW ?? '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));

/** Whether an address is private, loopback, link-local or shared (inside the server or its network). */
export function isPrivateAddress(ip) {
  let a = String(ip ?? '').trim().toLowerCase();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    return p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254) || (p === 100 && q >= 64 && q <= 127) || p === 0;
  }
  if (isIP(a) === 6) return a === '::1' || a === '::' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return false;
}

/**
 * Lookups from the database file, or null when there is no file: country(ip) -> 'US' | null, and location(ip) ->
 * { city, state, country } in English (any may be missing) | null.
 */
export async function openGeo(path = GEO_DB_PATH) {
  if (!existsSync(path)) return null;
  const reader = await maxmind.open(path);
  return {
    country: (ip) => reader.get(ip)?.country?.iso_code ?? null,
    location: (ip) => {
      const r = reader.get(ip);
      if (!r?.country) return null;
      return { city: r.city?.names?.en ?? null, state: r.subdivisions?.[0]?.names?.en ?? null, country: r.country.names?.en ?? r.country.iso_code ?? null };
    },
  };
}

const ipv4Number = (a) => a.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);

/** The top 64 bits of an IPv6 address (already checked with isIP) as a BigInt; an IPv4 tail is in the low bits. */
function ipv6High(a) {
  const [head, tail] = a.split('::');
  const groups = (s) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const before = groups(head);
  const after = tail === undefined ? [] : groups(tail);
  const all = [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  return all.slice(0, 4).reduce((n, g) => (n << 16n) + BigInt(`0x${g}`), 0n);
}

const byStart = (x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);

// Sorted ranges, with neighbouring or overlapping ranges of the same country joined into one.
function merged(ranges, one) {
  const out = [];
  for (const r of ranges.sort(byStart)) {
    const last = out[out.length - 1];
    if (last && last[2] === r[2] && r[0] <= last[1] + one) {
      if (r[1] > last[1]) last[1] = r[1];
    } else out.push(r);
  }
  return out;
}

/**
 * Apple's relay list ("prefix,CC,region,city," per line) as sorted [start, end, country] ranges: IPv4 as numbers,
 * IPv6 by the top 64 bits as BigInts (exact: Apple lists no prefix longer than /64, and a longer one is skipped).
 * Malformed lines are skipped.
 */
export function parseRelayRanges(text) {
  const v4 = [];
  const v6 = [];
  const countries = new Map(); // one string per country code, not one per line
  for (const line of String(text ?? '').split('\n')) {
    const [prefix = '', code = ''] = line.split(',', 2);
    const cc = code.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) continue;
    const slash = prefix.indexOf('/');
    if (slash < 0) continue;
    const addr = prefix.slice(0, slash).trim().toLowerCase();
    const bits = prefix.slice(slash + 1).trim();
    if (!/^\d{1,3}$/.test(bits)) continue;
    const len = Number(bits);
    if (!countries.has(cc)) countries.set(cc, cc);
    const country = countries.get(cc);
    const kind = isIP(addr);
    if (kind === 4 && len <= 32) {
      const size = 2 ** (32 - len);
      const start = ipv4Number(addr) - (ipv4Number(addr) % size);
      v4.push([start, start + size - 1, country]);
    } else if (kind === 6 && len <= 64 && !addr.includes('%')) {
      const size = 1n << BigInt(64 - len);
      const high = ipv6High(addr);
      const start = high - (high % size);
      v6.push([start, start + size - 1n, country]);
    }
  }
  return { v4: merged(v4, 1), v6: merged(v6, 1n) };
}

// The country of the last range starting at or before x, when x is inside it.
function find(ranges, x) {
  let lo = 0;
  let hi = ranges.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid][0] <= x) {
      hit = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return hit >= 0 && x <= ranges[hit][1] ? ranges[hit][2] : null;
}

/** ip -> the country Apple lists for it, or null when it is not a relay address. */
export function relayLookup({ v4, v6 }) {
  return (ip) => {
    let a = String(ip ?? '').trim().toLowerCase();
    if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
    const kind = isIP(a);
    if (kind === 4) return find(v4, ipv4Number(a));
    if (kind === 6 && !a.includes('%')) return find(v6, ipv6High(a));
    return null;
  };
}

/** The relay list's lookup, or null when there is no file (or nothing in it): { country(ip), v4, v6 (range counts) }. */
export function openRelay(path = RELAY_PATH) {
  if (!existsSync(path)) return null;
  const ranges = parseRelayRanges(readFileSync(path, 'utf8'));
  if (!ranges.v4.length && !ranges.v6.length) return null;
  return { country: relayLookup(ranges), v4: ranges.v4.length, v6: ranges.v6.length };
}

/** The country for the check: Apple's relay list first, then DB-IP for addresses it does not list. */
export const countryLookup = ({ relay = null, dbip = null } = {}) => (ip) => relay?.(ip) ?? dbip?.(ip) ?? null;

/** The first half of an address, for logs: 203.0.113.x or 2001:db8:1:: (a /24 or /48). */
export function shortAddress(ip) {
  const a = String(ip ?? '');
  if (isIP(a) === 4) return `${a.split('.').slice(0, 3).join('.')}.x`;
  if (isIP(a) === 6) return `${a.split(':').slice(0, 3).join(':')}::`;
  return 'unknown';
}

/**
 * The request check: returns true when the request must be refused. allow: country codes; lookup: ip -> country.
 * With no allow list, or no lookup (fail open), it never refuses. log.warn hears about refusals (see above).
 */
export function geoBlocker({ allow = [], lookup = null, log = null, now = () => Date.now() } = {}) {
  if (!allow.length || !lookup) return () => false;
  const logged = new Map(); // short address -> when last logged
  return (req) => {
    if (ALWAYS_OPEN.some((re) => re.test(req.url))) return false;
    const ip = req.ip;
    if (!ip || isPrivateAddress(ip)) return false;
    const country = lookup(ip);
    if (!country || allow.includes(country)) return false; // unknown addresses pass (see above)
    const short = shortAddress(ip);
    if (log?.warn && !(logged.has(short) && now() - logged.get(short) <= 3600_000)) {
      if (logged.size > 1000) logged.clear();
      logged.set(short, now());
      log.warn(`[geo] refused ${country} ${short}`);
    }
    return true;
  };
}

export const BLOCKED_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Job Hunt</title>' +
  '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;text-align:center;background:#f6f7f9;color:#1d2330}@media (prefers-color-scheme: dark){body{background:#12151b;color:#e6e9ef}}</style></head>' +
  '<body><h1>Job Hunt</h1><p>Job Hunt is available in the United States only.</p></body></html>';
