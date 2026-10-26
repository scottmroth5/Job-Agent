// Dates are stored as ISO calendar dates (YYYY-MM-DD). Arithmetic is done in UTC so the
// machine's time zone never shifts a date.

import { currentTimeZone } from '../db/scope.js';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// "Today" for the user is a calendar day in the app's time zone: TZ in .env (for example America/Chicago),
// else the machine's zone. A server runs on UTC, so never take today from toISOString(): in the evening in the Americas that
// is already tomorrow. Timestamps stay ISO UTC; only calendar days use these.

// Each user may have their own zone (Settings; db/scope.js carries it with the request or job): their calendar days
// follow it. The owner, scripts, and the schedule use the app's zone.

/** The time zone calendar days follow now: the current user's own, else the app's. */
export const timeZone = () => currentTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

const dayIn = (d, zone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

/** The calendar day (YYYY-MM-DD) of a moment, in the current user's zone (else the app's). */
export function localDay(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  const zone = currentTimeZone();
  return zone ? dayIn(d, zone) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local calendar day N days before a moment. */
export function localDaysAgo(at, days) {
  return shift(localDay(new Date(at)), days);
}

/** Whether a name is a time zone this server knows (Settings checks it before saving). */
export function isTimeZone(name) {
  if (typeof name !== 'string' || !name || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** A stored value as a local calendar day: a YYYY-MM-DD date passes through; an ISO timestamp is converted. */
export const dayOf = (v) => (v == null || v === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : localDay(new Date(v)));

/** Parses "6/26/2026" (v1 sheet format) or "2026-06-26". Returns an ISO date or null. */
export function parseSheetDate(raw) {
  const s = String(raw ?? '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return validDate(+m[3], +m[1], +m[2]);
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  return null;
}

/**
 * Parses a "posted" value: an absolute date, or a relative one such as "16 hours ago",
 * "3 days ago", "2 weeks ago", "today", counted back from the discovery date.
 * Returns an ISO date or null.
 */
export function parsePostedDate(raw, discoveredOn) {
  const absolute = parseSheetDate(raw);
  if (absolute) return absolute;
  const base = parseSheetDate(discoveredOn);
  if (!base) return null;
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^(today|just now|just posted|recent|recently)$/.test(s)) return base;
  if (s === 'yesterday') return shift(base, 1);
  const m = /^(\d+)\+?\s*(minute|min|hour|hr|day|week|month)s?\s+ago$/.exec(s);
  if (!m) return null;
  const n = +m[1];
  const days = { minute: 0, min: 0, hour: 0, hr: 0, day: n, week: n * 7, month: n * 30 }[m[2]];
  return shift(base, m[2].startsWith('h') ? Math.floor(n / 24) : days);
}

function validDate(y, mo, d) {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? iso(date) : null;
}

function shift(isoDate, daysBack) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  return iso(new Date(Date.UTC(y, mo - 1, d - daysBack)));
}
