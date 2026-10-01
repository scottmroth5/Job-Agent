// Query parameters that only track where a click came from; they never identify a different job.
const TRACKING = /^(utm_.*|trk.*|refid|trackingid|ref|gh_src|lever-source|source|src|fbclid|gclid|mc_.*)$/i;

/**
 * Key for deciding whether two URLs point at the same posting: lowercase host without www,
 * no fragment, no trailing slash, tracking parameters removed, remaining parameters sorted.
 * LinkedIn job links keep only their path, since every query parameter there is tracking.
 * Returns null for empty input and the trimmed, lowercased text for unparseable input.
 */
export function normalizeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return text.toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let path = url.pathname.replace(/\/+$/, '') || '';
  if (host.endsWith('linkedin.com')) {
    // /jobs/view/some-title-at-company-1234567890 and /jobs/view/1234567890 are the same job.
    const jobId = /\/jobs\/view\/(?:[^/]*-)?(\d{6,})$/i.exec(path)?.[1];
    return jobId ? `linkedin.com/jobs/view/${jobId}` : `${host}${path.toLowerCase()}`;
  }

  const params = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  return `${host}${path}${query}`;
}

const words = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

// Company: legal suffixes and spacing do not tell employers apart ("M3 USA", "M3USA", "Acme, Inc.").
const COMPANY_NOISE = new Set(['the', 'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'plc', 'gmbh', 'lp', 'llp']);
// Title: abbreviations spelled out, and words that vary between copies of one posting dropped.
const TITLE_WORDS = {
  vp: 'vice president',
  svp: 'senior vice president',
  evp: 'executive vice president',
  sr: 'senior',
  snr: 'senior',
  jr: 'junior',
  mgr: 'manager',
  dir: 'director',
  eng: 'engineering',
  engg: 'engineering',
  cto: 'chief technology officer',
  cio: 'chief information officer',
  ciso: 'chief information security officer',
};
const TITLE_NOISE = new Set(['of', 'the', 'and', 'for', 'a', 'an', 'remote']);

/**
 * Key for matching the same role across sources and spellings: "M3 USA | Vice President, Technology and
 * Product (Remote)" and "M3USA | VP Technology & Product" give the same key.
 */
export function companyTitleKey(company, title) {
  const c = words(company);
  const kept = c.filter((w) => !COMPANY_NOISE.has(w));
  const t = words(title)
    .flatMap((w) => (TITLE_WORDS[w] ?? w).split(' '))
    .filter((w) => !TITLE_NOISE.has(w));
  return `${(kept.length ? kept : c).join('')}|${t.join(' ')}`;
}
