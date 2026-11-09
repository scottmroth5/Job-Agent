// Display helpers shared by the table and the detail panel.

// Status, stage, and track labels come from the configurable lists: useLookups() in lookups.tsx.

/** The pay and hours fields of a job as the postings routes return them (server/queries.ts). */
export interface Range {
  min: number;
  max: number;
  unit?: string | null;
}
export interface PayFields {
  rateText?: string | null;
  rate?: Range | null;
  pay?: { min: number | null; max: number | null; unit?: string | null } | null;
  hours?: Range | null;
}

const money = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`);

const UNIT_SUFFIX: Record<string, string | undefined> = { hour: '/hr', month: '/mo', year: '/yr', project: ' project' };

export function rateText(p: PayFields) {
  if (p.rateText) return p.rateText;
  if (!p.rate) return '';
  const unit = UNIT_SUFFIX[p.rate.unit ?? ''] ?? '';
  return p.rate.min === p.rate.max ? `${money(p.rate.min)}${unit}` : `${money(p.rate.min)} to ${money(p.rate.max)}${unit}`;
}

export const PAY_FROM: Record<string, string | undefined> = { terms: 'Pay terms on the job', source: 'Listed by the job site', description: 'Found in the job description' };

/** "$170K to $210K/yr" from row.pay, or ''. */
export function payText(p: PayFields) {
  const pay = p.pay;
  if (!pay || pay.min == null) return p.rateText ?? '';
  const unit = UNIT_SUFFIX[pay.unit ?? ''] ?? '';
  return pay.min === pay.max ? `${money(pay.min)}${unit}` : `${money(pay.min)} to ${money(pay.max as number)}${unit}`;
}

export function hoursText(p: PayFields) {
  if (!p.hours) return '';
  return p.hours.min === p.hours.max ? `${p.hours.min} hrs/wk` : `${p.hours.min} to ${p.hours.max} hrs/wk`;
}

export function annualText(a: { low: number; mid: number; high: number } | null | undefined) {
  if (!a) return '';
  return a.low === a.high ? `${money(a.mid)}/yr` : `${money(a.low)} to ${money(a.high)}/yr`;
}

/** "Mon, Oct 5, 9:14 AM" in the viewer's time zone; '' for no date. */
export function dateTime(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function scoreClass(score: number | null | undefined) {
  if (score == null) return 'score none';
  return `score ${score >= 8 ? 'high' : score >= 7 ? 'good' : score >= 5 ? 'mid' : 'low'}`;
}

export const moneyShort = money;

// Where a job was found, in the same words on every screen (Jobs, the job panel, Funnel).
const SOURCE_LABELS: Record<string, string | undefined> = { manual: 'Added by hand', 'v1-manual': 'Added by hand (v1)', 'google jobs': 'Google results', email: 'Recruiter email' };
export const sourceLabel = (s: string | null | undefined) => SOURCE_LABELS[s ?? ''] ?? SOURCE_LABELS[String(s ?? '').toLowerCase()] ?? s ?? '';
