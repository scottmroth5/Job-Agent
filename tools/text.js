// Emoji and other pictographs, with the joiners, variation selectors, flag letters, and keycap marks they are built from.
const PICTOGRAPHS = /[\p{Extended_Pictographic}\p{Regional_Indicator}‍︎️⃣]/gu;

/**
 * Text without emoji or pictographs ("🧪 Vice President, Engineering" becomes "Vice President, Engineering"), for job
 * titles and anything written into a Word or PDF document, where they show as a picture or a "?". Spaces left behind
 * are closed up; other symbols (accents, curly quotes, dashes) are kept.
 */
export function withoutPictographs(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(PICTOGRAPHS, '')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n');
}

/**
 * A letter body's paragraphs: blank lines separate them, and the lines of one paragraph join with a space. Line by
 * line with no pattern, so text straight from a request (a user's own letter) cannot make it backtrack.
 */
export function paragraphsOf(text) {
  const out = [];
  let current = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line) current.push(line);
    else if (current.length) {
      out.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) out.push(current.join(' '));
  return out;
}

/**
 * Replaces em dashes, en dashes, and double hyphens used as dashes with commas (v1's rule:
 * generated text never contains dashes of any kind). Hyphens inside words are left alone.
 */
export function sanitizeDashes(text) {
  if (typeof text !== 'string' || !text) return text;
  // One pass, no backtracking (letter text can come straight from a request): each em dash, en dash, or "--", with the
  // spaces around it, becomes ", "; a comma right after another (spaces between) is dropped; then commas at either end.
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0';
  let out = '';
  let i = 0;
  while (i < text.length) {
    const dash = text[i] === '\u2014' || text[i] === '\u2013' ? 1 : text[i] === '-' && text[i + 1] === '-' ? 2 : 0;
    if (dash) {
      let end = out.length;
      while (end > 0 && isSpace(out[end - 1])) end -= 1;
      out = out.slice(0, end);
      i += dash;
      while (i < text.length && isSpace(text[i])) i += 1;
      // ", ," and ",," become one comma: skip this comma when the text already ends in one.
      out += out.endsWith(',') ? ' ' : ', ';
      continue;
    }
    if (text[i] === ',') {
      let end = out.length;
      while (end > 0 && isSpace(out[end - 1])) end -= 1;
      if (out[end - 1] === ',') {
        out = out.slice(0, end);
        i += 1;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  out = out.trim();
  if (out.startsWith(',')) out = out.slice(1).trimStart();
  if (out.endsWith(',')) out = out.slice(0, -1).trimEnd();
  return out;
}

/** Cuts text to at most max characters, preferring a line or sentence boundary near the end. */
export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return (boundary > max * 0.8 ? cut.slice(0, boundary + 1) : cut).trimEnd() + '\n[truncated]';
}
