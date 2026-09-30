// Rate and hours parsing for fractional roles, and the tracker's annualized math.

const UNITS = [
  ['hour', /\/\s*h(ou)?r\b|per\s+hour|\bhourly\b|\/\s*hour/i],
  ['month', /\/\s*mo(nth)?\b|per\s+month|\bmonthly\b|\/\s*month/i],
  ['year', /\/\s*y(ea)?r\b|per\s+year|\bannual(ly)?\b|\bsalary\b/i],
  ['project', /per\s+project|\bproject\b|fixed\s+fee/i],
];

const money = /\$\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?/g;
const amount = (digits, suffix) => {
  const n = Number(digits.replace(/,/g, ''));
  return suffix?.toLowerCase() === 'k' ? n * 1000 : suffix?.toLowerCase() === 'm' ? n * 1_000_000 : n;
};

/**
 * Parses pay text such as "$5K - $6K / mo", "Est. $175 to $225/hr", "$10K to $20K/mo", "$200k - $250k".
 * Returns { min, max, unit } (unit may be null when it cannot be told) or null when there is no amount.
 * Without an explicit unit: 20,000+ reads as a year, under 1,000 as an hour.
 */
export function parseRate(text) {
  const s = String(text ?? '');
  const values = [...s.matchAll(money)].map((m) => amount(m[1], m[2]));
  if (!values.length) return null;
  const [first, second] = values;
  // "$5K - 6K": a bare second number after a range separator shares the first's scale.
  const bare = second === undefined ? /\$\s*[\d.,]+\s*([kK])?\s*(?:-|–|to)\s*([\d.,]+)\s*([kK])?/.exec(s) : null;
  const max = second ?? (bare ? amount(bare[2], bare[3] ?? bare[1]) : first);
  let unit = UNITS.find(([, re]) => re.test(s))?.[0] ?? null;
  if (!unit) unit = first >= 20000 ? 'year' : first < 1000 ? 'hour' : null;
  return { min: Math.min(first, max), max: Math.max(first, max), unit };
}

/**
 * Parses weekly hours such as "5 - 8 hrs", "8 to 15 (10 to 20 to start)", "20 hours/week".
 * Uses the first number or range. Returns { min, max } or null.
 */
export function parseHours(text) {
  const s = String(text ?? '');
  const m = /(\d+(?:\.\d+)?)\s*(?:(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(?:\(|hrs?\b|hours?\b|h\/w|\/\s*w(ee)?k|per\s+week|$)/i.exec(s);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (!(a > 0) || a > 80 || b > 80) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/**
 * Annualized earnings range the way the tracker computes it: hourly rate x weekly hours x weeks,
 * monthly rate x 12, yearly as is. Returns { low, mid, high } in dollars, or null when it cannot be computed.
 */
export function annualize(rate, hours, weeksPerYear = 48) {
  if (!rate || rate.min == null) return null;
  const mid = (a, b) => (a + b) / 2;
  if (rate.unit === 'year') return { low: rate.min, mid: mid(rate.min, rate.max), high: rate.max };
  if (rate.unit === 'month') return { low: rate.min * 12, mid: mid(rate.min, rate.max) * 12, high: rate.max * 12 };
  if (rate.unit === 'hour' && hours?.min != null) {
    return {
      low: rate.min * hours.min * weeksPerYear,
      mid: mid(rate.min, rate.max) * mid(hours.min, hours.max) * weeksPerYear,
      high: rate.max * hours.max * weeksPerYear,
    };
  }
  return null;
}
