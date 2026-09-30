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
  if (host.endsWith('linkedin.com')) return `${host}${path.toLowerCase()}`;

  const params = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  return `${host}${path}${query}`;
}

/** Key for matching the same role across sources: lowercase, punctuation removed, spaces collapsed. */
export function companyTitleKey(company, title) {
  const clean = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  return `${clean(company)}|${clean(title)}`;
}
