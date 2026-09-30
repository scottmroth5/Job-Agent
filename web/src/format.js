// Display helpers shared by the table and the detail panel.

export const STATUSES = ['new', 'applied', 'interviewing', 'offer', 'passed', 'closed', 'rejected'];
export const STATUS_LABELS = { new: 'New', applied: 'Applied', interviewing: 'Interviewing', offer: 'Offer', passed: 'Passed', closed: 'Closed', rejected: 'Rejected' };

const money = (n) => (n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`);

export function rateText(p) {
  if (p.rateText) return p.rateText;
  if (!p.rate) return '';
  const unit = { hour: '/hr', month: '/mo', year: '/yr', project: ' project' }[p.rate.unit] ?? '';
  return p.rate.min === p.rate.max ? `${money(p.rate.min)}${unit}` : `${money(p.rate.min)} to ${money(p.rate.max)}${unit}`;
}

export function hoursText(p) {
  if (!p.hours) return '';
  return p.hours.min === p.hours.max ? `${p.hours.min} hrs/wk` : `${p.hours.min} to ${p.hours.max} hrs/wk`;
}

export function annualText(a) {
  if (!a) return '';
  return a.low === a.high ? `${money(a.mid)}/yr` : `${money(a.low)} to ${money(a.high)}/yr`;
}

export function scoreClass(score) {
  if (score == null) return 'score none';
  return `score ${score >= 8 ? 'high' : score >= 7 ? 'good' : score >= 5 ? 'mid' : 'low'}`;
}

export const moneyShort = money;
