// Cover letter and resume tweak helpers ported from v1 (legacy/job_hunt_agent.js):
// role type, analysis text for prompts, salutation/sign-off stripping, rule checks, and the Doc layout.
import { escapeHtml } from '../../tools/html.js';
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

/** Drive file name, e.g. "Example_Co_VP_Engineering_CoverLetter_2026-09-30". */
export function letterDocName(company, title, isoDate) {
  const part = (s) => String(s ?? '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
  return `${part(company)}_${part(title)}_CoverLetter_${isoDate}`;
}

/** The cover letter as HTML for conversion to a Google Doc (v1's layout). Everything is escaped. */
export function letterHtml({ candidate, company, title, date, body }) {
  const p = (s, style = '') => `<p${style ? ` style="${style}"` : ''}>${escapeHtml(s)}</p>`;
  const paragraphs = String(body ?? '')
    .split(/\n\s*\n/)
    .map((para) => para.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .map((para) => p(para))
    .join('\n');
  return [
    '<html><body>',
    `<h1>${escapeHtml(candidate.name)}</h1>`,
    candidate.contactLine ? p(candidate.contactLine, 'font-style:italic') : '',
    candidate.linkedin ? p(candidate.linkedin, 'font-style:italic') : '',
    '<p></p>',
    p(date),
    `<p><b>${escapeHtml(`Re: ${title} at ${company}`)}</b></p>`,
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
