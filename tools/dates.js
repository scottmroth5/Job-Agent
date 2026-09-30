// Dates are stored as ISO calendar dates (YYYY-MM-DD). Arithmetic is done in UTC so the
// machine's time zone never shifts a date.

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

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
