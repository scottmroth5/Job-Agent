// Title filters. Keywords match as whole words or phrases (case-insensitive), so "cto"
// no longer matches inside "director" as it did in v1's substring check.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (kw) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(kw.trim().toLowerCase())}(?![\\p{L}\\p{N}])`, 'iu');

/** Builds a matcher for a keyword list; an empty list never matches. */
export function keywordMatcher(keywords = []) {
  const patterns = keywords.filter((k) => k && k.trim()).map(phrase);
  return (title) => patterns.some((p) => p.test(String(title ?? '')));
}

/** v1's job type detection from title and description text. */
export function detectJobType(title, description = '') {
  const t = `${title ?? ''} ${description ?? ''}`.toLowerCase();
  if (t.includes('fractional')) return 'Fractional';
  if (t.includes('interim')) return 'Interim';
  if (/\bcontract(or)?\b/.test(t)) return 'Contract';
  if (/part[- ]time/.test(t)) return 'Part-time';
  if (/full[- ]time/.test(t)) return 'Full-time';
  if (/\btemporary\b|\btemp\b/.test(t)) return 'Contract';
  return null;
}
