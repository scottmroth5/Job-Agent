/**
 * Replaces em dashes, en dashes, and double hyphens used as dashes with commas (v1's rule:
 * generated text never contains dashes of any kind). Hyphens inside words are left alone.
 */
export function sanitizeDashes(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+--\s+/g, ', ')
    .replace(/--/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/^,\s*|\s*,$/g, '')
    .trim();
}

/** Cuts text to at most max characters, preferring a line or sentence boundary near the end. */
export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return (boundary > max * 0.8 ? cut.slice(0, boundary + 1) : cut).trimEnd() + '\n[truncated]';
}
