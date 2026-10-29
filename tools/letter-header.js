// A cover letter's contact lines, shared by the Word, PDF, and Google Doc layouts: the contact line split on "|" and a
// line of links (LinkedIn, website, GitHub), each part { text, url } with url null for plain text. An email address
// links as mailto:, a web address (with or without https://) as itself; everything else stays text. No patterns run
// over the text: addresses are checked with URL parsing.
import { withoutPictographs } from './text.js';

const isEmail = (s) => {
  const at = s.indexOf('@');
  return at > 0 && at === s.lastIndexOf('@') && !s.includes(' ') && s.slice(at + 1).includes('.') && !s.slice(at + 1).startsWith('.');
};

/** The link for one part, or null: mailto: for an email, https:// for a web address such as "github.com/name". */
export function hrefOf(text) {
  const s = String(text ?? '').trim();
  if (!s || s.includes(' ')) return null;
  if (isEmail(s)) return `mailto:${s}`;
  try {
    const u = new URL(s.startsWith('http://') || s.startsWith('https://') ? s : `https://${s}`);
    const labels = u.hostname.split('.');
    return labels.length >= 2 && labels.every(Boolean) && /^[a-z]{2,}$/i.test(labels.at(-1)) ? u.href : null;
  } catch {
    return null;
  }
}

/** The header's contact lines: [[{ text, url }...], ...], with empty lines left out. */
export function headerLines(candidate = {}) {
  const part = (t) => {
    const text = withoutPictographs(String(t ?? '').trim());
    return text ? { text, url: hrefOf(text) } : null;
  };
  const contact = String(candidate.contactLine ?? '').split('|').map(part).filter(Boolean);
  const links = [candidate.linkedin, candidate.website, candidate.github].map(part).filter(Boolean);
  return [contact, links].filter((line) => line.length);
}

export const SEPARATOR = ' | ';
