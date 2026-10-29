// A cover letter's header, shared by the Word, PDF, and Google Doc layouts. The header is each user's own (Settings >
// Cover letter header, agents/letter-header.js): name, email, phone, an optional location, the sign-off name, and links.
// Until they save one it comes from their settings (candidate.name, contactLine, linkedin, website, github), through
// fromCandidate. headerLines gives the contact lines as parts { text, url } (url null for plain text): email, phone,
// and location on one line, then the links, as many to a line as fit. An email links as mailto:, a web address
// (with or without https://) as itself. No patterns run over the text: addresses are checked with URL parsing.
import { withoutPictographs } from './text.js';

export const SEPARATOR = ' | ';
const LINE_CHARS = 75; // links share a line up to about this many characters

export const isEmail = (s) => {
  const t = String(s ?? '').trim();
  const at = t.indexOf('@');
  return at > 0 && at === t.lastIndexOf('@') && !t.includes(' ') && t.slice(at + 1).includes('.') && !t.slice(at + 1).startsWith('.');
};
// A phone number: digits with spaces, dots, dashes, parentheses, a leading +, or an extension, and at least 7 digits.
const isPhone = (s) => {
  const t = String(s ?? '').trim();
  const digits = [...t].filter((c) => c >= '0' && c <= '9').length;
  return digits >= 7 && [...t.toLowerCase()].every((c) => '0123456789 .-()+xext'.includes(c));
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

/** A header from the older settings fields: the contact line's parts sorted into email, phone, and location. */
export function fromCandidate(c = {}) {
  const parts = String(c.contactLine ?? '').split('|').map((p) => p.trim()).filter(Boolean);
  const email = parts.find(isEmail) ?? '';
  const phone = parts.find((p) => !isEmail(p) && isPhone(p)) ?? '';
  const location = parts.filter((p) => p !== email && p !== phone && !hrefOf(p)).join(', ');
  const links = [...parts.filter((p) => p !== email && hrefOf(p)), c.linkedin, c.website, c.github].map((u) => String(u ?? '').trim()).filter(Boolean);
  return { name: String(c.name ?? '').trim(), signoffName: String(c.signoffName ?? '').trim(), email, phone, location, links: [...new Set(links)] };
}

/** The header's contact lines: [[{ text, url }...], ...], with empty lines left out. Takes a header or older settings. */
export function headerLines(header = {}) {
  const h = Array.isArray(header.links) ? header : fromCandidate(header);
  const part = (t, url) => {
    const text = withoutPictographs(String(t ?? '').trim());
    return text ? { text, url: url === undefined ? hrefOf(text) : url } : null;
  };
  const contact = [part(h.email), part(h.phone, null), part(h.location, null)].filter(Boolean);
  const lines = [contact];
  let line = [];
  let chars = 0;
  for (const p of h.links.map((u) => part(u)).filter(Boolean)) {
    if (line.length && chars + SEPARATOR.length + p.text.length > LINE_CHARS) {
      lines.push(line);
      line = [];
      chars = 0;
    }
    chars += (line.length ? SEPARATOR.length : 0) + p.text.length;
    line.push(p);
  }
  lines.push(line);
  return lines.filter((l) => l.length);
}
