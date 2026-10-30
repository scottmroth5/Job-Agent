// Cover letter and resume tweak helpers ported from v1 (legacy/job_hunt_agent.js):
// role type, analysis text for prompts, salutation/sign-off stripping, rule checks, and the Doc layout.
import { escapeHtml } from '../../tools/html.js';
import { fileTitle, paragraphsOf, withoutPictographs } from '../../tools/text.js';
import { headerLines, SEPARATOR } from '../../tools/letter-header.js';
import { keywordMatcher } from '../../tools/titles.js';

const executive = keywordMatcher(['cto', 'vp', 'vice president', 'chief', 'director', 'head of']);

/** v1's role positioning: executive titles use the executive resume positioning. */
export function roleTypeText(title) {
  return executive(title) ? 'executive (CTO, VP, Director)' : 'engineering manager or SDM';
}

/** Formats a v2 score analysis the way the hunt prompts refer to it (TOP TALKING POINT, KEY STRENGTHS). */
export function formatAnalysis(a) {
  const bullets = (xs) => (xs?.length ? xs.map((x) => `• ${x}`).join('\n') : '• None noted');
  return [
    `FIT SCORE: ${a.score} of 10. ${a.reason ?? ''}`.trim(),
    `ROLE TYPE: ${a.roleType ?? 'Unknown'}`,
    `KEY STRENGTHS:\n${bullets(a.strengths)}`,
    `WATCH OUTS:\n${bullets(a.watchOuts)}`,
    `TOP TALKING POINT: ${a.topTalkingPoint ?? ''}`.trim(),
  ].join('\n\n');
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes any salutation or sign-off the model adds; the Doc template supplies them (v1 behavior). */
export function stripSalutationAndSignoff(text, names = []) {
  const who = names.filter(Boolean).map(escapeRegex);
  const signoff = new RegExp(`^\\s*(sincerely|best regards|kind regards|regards|thank you|warm regards${who.length ? `|${who.join('|')}` : ''})\\b`, 'i');
  const lines = String(text ?? '').split('\n');
  while (lines.length && (/^\s*$/.test(lines[0]) || /^\s*dear\b/i.test(lines[0]))) lines.shift();
  while (lines.length && (/^\s*$/.test(lines[lines.length - 1]) || signoff.test(lines[lines.length - 1]))) lines.pop();
  return lines.join('\n');
}

// The greeting that ends a letter's header ("Dear Example Co Hiring Team,", "To whom it may concern:"), on its own line or
// run into the header when a PDF's lines were joined. Searched only near the start; quantifiers are bounded.
const GREETING = /(?:^|\s)(?:dear\s[^,:\n]{1,80}|to whom it may concern)[,:]/i;
const GREETING_LINE = /^[ \t]*(?:hello|hi|greetings)\b[^,:\n]{0,60}[,:!][ \t]*$/im;
// A sign-off and what follows it (name, contact lines) near the end: "Sincerely,\nPat Example\npat@example.com".
const SIGNOFF = /(?:^|[\s.!?])(?:sincerely|best regards|kind regards|warm regards|warmest regards|regards|respectfully|best wishes|with gratitude|thank you)[,!][\s\S]{0,200}$/i;

/**
 * Paragraphs for text with none (a PDF's lines, wrapped at the page edge, with no blank lines between paragraphs):
 * a line that ends a sentence and stops well short of the longest lines ends its paragraph. Text that has blank
 * lines already is left alone.
 */
export function paragraphsFromLines(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (s.includes('\n\n')) return s;
  const lines = s.split('\n').map((l) => l.trim());
  if (lines.length < 4) return s;
  const longest = Math.max(...lines.map((l) => l.length));
  const ends = (l) => /[.!?:]["'”’)]?$/.test(l) && l.length < longest * 0.85;
  const paragraphs = [];
  let current = [];
  for (const l of lines) {
    if (l) current.push(l);
    if (l && ends(l)) {
      paragraphs.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs.join('\n\n');
}

/**
 * The body of a letter the user wrote (pasted, or read from a file): paragraphs rebuilt when the text has none, and
 * the header (name, contact lines, date, "Re:" line, greeting) and the sign-off with whatever follows it taken off,
 * since the Word and PDF layout adds them. Text with no greeting near its start keeps its first lines.
 */
export function userLetterBody(text, names = []) {
  let s = paragraphsFromLines(text);
  const head = s.slice(0, 1200);
  const greeting = GREETING.exec(head) ?? GREETING_LINE.exec(head);
  if (greeting) s = s.slice(greeting.index + greeting[0].length);
  const tailFrom = Math.max(0, s.length - 400);
  const signoff = SIGNOFF.exec(s.slice(tailFrom));
  if (signoff) s = s.slice(0, tailFrom + signoff.index + (/^[.!?]/.test(signoff[0]) ? 1 : 0));
  return stripSalutationAndSignoff(s, names).trim();
}

/**
 * Runs the configured cover letter checks. Each rule has a label and either
 * text (one pattern against the whole letter) or sentence (two patterns that must both match one sentence).
 * Returns the labels of the rules that fired, without duplicates.
 */
export function checkCoverLetter(text, rules = []) {
  const sentences = String(text ?? '').split(/(?<=[.!?])\s+/);
  const fired = [];
  for (const rule of rules) {
    let hit = false;
    try {
      if (rule.text) hit = new RegExp(rule.text, 'i').test(text);
      if (!hit && Array.isArray(rule.sentence) && rule.sentence.length === 2) {
        const [a, b] = rule.sentence.map((p) => new RegExp(p, 'i'));
        hit = sentences.some((s) => a.test(s) && b.test(s));
      }
    } catch {
      hit = false; // invalid patterns are rejected by config validation; never fail a letter over one
    }
    if (hit && !fired.includes(rule.label)) fired.push(rule.label);
  }
  return fired;
}

/** The letter's file and Google Doc name, e.g. "Pat Example VP, Engineering at Example Co Cover Letter". */
export function letterDocName(name, title, company) {
  return fileTitle(name, title, company && `at ${company}`, 'Cover Letter');
}

/** The cover letter as HTML for conversion to a Google Doc (v1's layout). Everything is escaped. */
export function letterHtml({ candidate, company, title, date, body }) {
  const p = (s, style = '') => `<p${style ? ` style="${style}"` : ''}>${escapeHtml(withoutPictographs(s))}</p>`;
  const paragraphs = paragraphsOf(body)
    .map((para) => p(para))
    .join('\n');
  return [
    '<html><body>',
    `<h1>${escapeHtml(withoutPictographs(candidate.name))}</h1>`,
    ...headerLines(candidate).map(
      (parts) => `<p style="font-style:italic">${parts.map((x) => (x.url ? `<a href="${escapeHtml(x.url)}">${escapeHtml(x.text)}</a>` : escapeHtml(x.text))).join(SEPARATOR)}</p>`,
    ),
    '<p></p>',
    p(date),
    `<p><b>${escapeHtml(withoutPictographs(`Re: ${title} at ${company}`))}</b></p>`,
    '<p></p>',
    p(`Dear ${company} Hiring Team,`),
    paragraphs,
    '<p></p>',
    p('Sincerely,'),
    p(candidate.signoffName || candidate.name),
    '</body></html>',
  ]
    .filter(Boolean)
    .join('\n');
}
