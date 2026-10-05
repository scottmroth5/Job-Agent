// Display helpers shared by the table and the detail panel.

export const STATUSES = ['new', 'applied', 'interviewing', 'offer', 'passed', 'closed', 'rejected', 'duplicate'];
export const STATUS_LABELS = { new: 'New', applied: 'Applied', interviewing: 'Interviewing', offer: 'Offer', passed: 'Passed', closed: 'Closed', rejected: 'Rejected', duplicate: 'Duplicate' };

const money = (n) => (n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`);

export function rateText(p) {
  if (p.rateText) return p.rateText;
  if (!p.rate) return '';
  const unit = { hour: '/hr', month: '/mo', year: '/yr', project: ' project' }[p.rate.unit] ?? '';
  return p.rate.min === p.rate.max ? `${money(p.rate.min)}${unit}` : `${money(p.rate.min)} to ${money(p.rate.max)}${unit}`;
}

const UNIT_SUFFIX = { hour: '/hr', month: '/mo', year: '/yr', project: ' project' };
export const PAY_FROM = { terms: 'Pay terms on the job', source: 'Listed by the job site', description: 'Found in the job description' };

/** "$170K to $210K/yr" from row.pay, or ''. */
export function payText(p) {
  const pay = p.pay;
  if (!pay || pay.min == null) return p.rateText ?? '';
  const unit = UNIT_SUFFIX[pay.unit] ?? '';
  return pay.min === pay.max ? `${money(pay.min)}${unit}` : `${money(pay.min)} to ${money(pay.max)}${unit}`;
}

export function hoursText(p) {
  if (!p.hours) return '';
  return p.hours.min === p.hours.max ? `${p.hours.min} hrs/wk` : `${p.hours.min} to ${p.hours.max} hrs/wk`;
}

export function annualText(a) {
  if (!a) return '';
  return a.low === a.high ? `${money(a.mid)}/yr` : `${money(a.low)} to ${money(a.high)}/yr`;
}

/** "Mon, Oct 5, 9:14 AM" in the viewer's time zone; '' for no date. */
export function dateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function scoreClass(score) {
  if (score == null) return 'score none';
  return `score ${score >= 8 ? 'high' : score >= 7 ? 'good' : score >= 5 ? 'mid' : 'low'}`;
}

export const moneyShort = money;
