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
  let [first, second] = values;
  // A range shares one scale when only one side has it: "$5K - 6K", "$10-20k/month".
  const range = /\$\s*(\d[\d.,]*)\s*([kK])?\s*(?:-|–|—|to)\s*\$?\s*(\d[\d.,]*)\s*([kK])?/.exec(s);
  if (range) {
    first = amount(range[1], range[2] ?? range[4]);
    second = amount(range[3], range[4] ?? range[2]);
  }
  const max = second ?? first;
  let unit = UNITS.find(([, re]) => re.test(s))?.[0] ?? null;
  if (!unit) unit = first >= 20000 ? 'year' : first < 1000 ? 'hour' : null;
  return { min: Math.min(first, max), max: Math.max(first, max), unit };
}

// A pay range written in a posting: "$170,000 - $210,000", "$150K–$200K per year", "$80 to $95/hr".
// Not followed by "million"/"billion" (funding and revenue figures).
const PAY_RANGE =
  /\$\s*\d[\d,]*(?:\.\d+)?\s*[kK]?\s*(?:-|–|—|to)\s*\$?\s*\d[\d,]*(?:\.\d+)?\s*[kK]?(?!\s*(?:million|billion|mm\b|[mMbB]\b))(?:\s*(?:\/\s*(?:yr|year|hr|hour|mo|month)\b|per\s+(?:year|hour|month|annum)|annually|hourly|a year|an hour))?/gi;
const EXPLICIT_UNIT = /\/\s*(yr|year|hr|hour|mo|month)\b|per\s+(year|hour|month|annum)|annually|hourly|a year|an hour/i;

/**
 * The first plausible pay range in posting text, as { min, max, unit, text }, or null.
 * Hourly and monthly ranges count only with an explicit unit; a bare range must look like a salary.
 */
export function findPayInText(text) {
  for (const m of String(text ?? '').matchAll(PAY_RANGE)) {
    const rate = parseRate(m[0]);
    if (!rate) continue;
    const explicit = EXPLICIT_UNIT.test(m[0]);
    const ok =
      rate.unit === 'year'
        ? rate.min >= 30000 && rate.max <= 2_000_000
        : explicit && ((rate.unit === 'hour' && rate.min >= 15 && rate.max <= 1000) || (rate.unit === 'month' && rate.min >= 1000 && rate.max <= 100000));
    if (ok) return { ...rate, text: m[0].trim() };
  }
  return null;
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
