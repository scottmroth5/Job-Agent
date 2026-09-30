// Full-time vs fractional track for a posting.

export const FRACTIONAL_SOURCES = ['Fractional Jobs', 'Go Fractional'];
const FRACTIONAL_TITLE = /\b(fractional|interim|advisor|advisory|part[- ]time)\b/i;
const FRACTIONAL_TEXT = /\bfractional\b/i;
const FULL_TIME_HOURS = 30;

/**
 * 'fractional' when the source is a fractional board, the item came from a fractional search,
 * the title or the start of the description says so, or the role is under 30 hours a week.
 * @param {{source?, searchTrack?, title?, description?, hoursMax?}} item
 */
export function detectTrack({ source, searchTrack, title, description, hoursMax } = {}) {
  if (FRACTIONAL_SOURCES.includes(source)) return 'fractional';
  if (searchTrack === 'fractional') return 'fractional';
  if (FRACTIONAL_TITLE.test(String(title ?? ''))) return 'fractional';
  if (FRACTIONAL_TEXT.test(String(description ?? '').slice(0, 600))) return 'fractional';
  if (hoursMax != null && hoursMax < FULL_TIME_HOURS) return 'fractional';
  return 'fulltime';
}
