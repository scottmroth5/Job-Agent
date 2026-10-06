// Company and job title from the subject or opening lines of applicant-tracking-system emails, plus body
// trimming. Deterministic, so most confirmations and rejections match without asking Claude.
import { htmlToText } from '../../tools/html.js';

const clean = (s) =>
  String(s ?? '')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s!.:,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;

// Each pattern names its groups; both are optional per pattern.
const SUBJECT_PATTERNS = [
  /^(?:re:\s*)?your application (?:for|to) (?:the )?(?<title>.+?) (?:position |role )?at (?<company>.+)$/i,
  /^(?:re:\s*)?application for (?:the )?(?<title>.+?) (?:position |role )?at (?<company>.+)$/i,
  /^thank(?:s| you) for (?:your )?(?:applying|application|interest) (?:in|to|for) (?:the )?(?<title>.+?) (?:position |role )?at (?<company>.+)$/i,
  /^thank(?:s| you) for (?:your )?(?:applying|application|interest) (?:in|to|with|at) (?<company>.+)$/i,
  /^(?:.+?, )?your application was sent to (?<company>.+)$/i,
  /^your application (?:to|with|at) (?<company>.+)$/i,
  /^(?<company>.+?)\s*[-|–:]\s*(?:application (?:received|confirmation|update)|thank you for (?:applying|your application))$/i,
  /^(?:an )?update on your (?:application (?:to|with|at) (?<company>.+)|(?<title>.+?) application)$/i,
  /^(?:an )?update on the (?<title>.+?) (?:position|role|opening|application) (?:at|with) (?<company>.+)$/i,
  /^(?:important )?information about your (?:application|candidacy) (?:to|with|at) (?<company>.+)$/i,
];

const BODY_PATTERNS = [
  /(?:applying|application|interest) (?:for|in) (?:the |our )?(?<title>[A-Z][^.,\n]{2,80}?) (?:position|role|opening|opportunity)? ?(?:at|with) (?<company>[A-Z][^.,\n]{1,60})/,
];

/**
 * { company, title } from an ATS email, either may be null; null when nothing was recognized.
 * Subject patterns win; the body is used only when the subject gave nothing.
 */
export function parseAtsEmail({ subject, body } = {}) {
  const s = String(subject ?? '').trim();
  for (const re of SUBJECT_PATTERNS) {
    const m = re.exec(s);
    if (m?.groups && (m.groups.company || m.groups.title)) return { company: clean(m.groups.company), title: clean(m.groups.title) };
  }
  const head = String(body ?? '').slice(0, 1500);
  for (const re of BODY_PATTERNS) {
    const m = re.exec(head);
    if (m?.groups) return { company: clean(m.groups.company), title: clean(m.groups.title) };
  }
  return null;
}

/** Plain text of an email body: HTML converted, quoted replies and signatures after "-- " dropped, trimmed to max. */
export function trimBody(text, { html = false, max = 4000 } = {}) {
  let t = html ? htmlToText(text) : String(text ?? '');
  t = t.replace(/\r\n/g, '\n');
  const quoted = /^\s*On .{5,200}wrote:\s*$/m.exec(t);
  if (quoted) t = t.slice(0, quoted.index);
  t = t
    .split('\n')
    .filter((l) => !l.startsWith('>'))
    .join('\n');
  const sig = t.indexOf('\n-- \n');
  if (sig >= 0) t = t.slice(0, sig);
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? `${t.slice(0, max)}\n[trimmed]` : t;
}
