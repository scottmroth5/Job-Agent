import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleTypeText, formatAnalysis, stripSalutationAndSignoff, checkCoverLetter, letterDocName, letterHtml, paragraphsFromLines, userLetterBody } from '../agents/hunt/letters.js';
import { escapeHtml } from '../tools/html.js';

// Synthetic names and rules only.
test('roleTypeText picks executive positioning by title', () => {
  assert.match(roleTypeText('VP of Engineering'), /^executive/);
  assert.match(roleTypeText('Head of Platform'), /^executive/);
  assert.match(roleTypeText('Engineering Manager'), /^engineering manager/);
});

test('formatAnalysis matches what the hunt prompts refer to', () => {
  const text = formatAnalysis({ score: 8, reason: 'Strong fit.', roleType: 'Full time', strengths: ['Scale', 'Hiring'], watchOuts: [], topTalkingPoint: 'Platform growth' });
  assert.match(text, /^FIT SCORE: 8 of 10\. Strong fit\./);
  assert.match(text, /KEY STRENGTHS:\n• Scale\n• Hiring/);
  assert.match(text, /WATCH OUTS:\n• None noted/);
  assert.match(text, /TOP TALKING POINT: Platform growth$/);
});

test("your own letter keeps only its body: the header, greeting, and sign-off go, and a PDF's lines become paragraphs", () => {
  const names = ['Pat Example', 'Pat'];
  const p1 = 'Taking Example Health from single digit weekly orders to over a thousand a day meant owning reliability and compliance together.';
  const p2 = 'I formed a platform team that began with one senior engineer, and that team owned every deployment decision.';
  // A Word file: paragraphs separated by blank lines, the header as its own paragraphs.
  const word = `Pat Example\n\npat@example.com | 555-0100\n\nOctober 29, 2026\n\nRe: VP Engineering at Example Co\n\nDear Example Co Hiring Team,\n\n${p1}\n\n${p2}\n\nSincerely,\n\nPat Example`;
  assert.equal(userLetterBody(word, names), `${p1}\n\n${p2}`);
  // A PDF: lines wrapped at the page edge, no blank lines; a paragraph ends on a short line that ends a sentence.
  const wrap = (p) => p.match(/.{1,60}(\s|$)/g).map((l) => l.trim()).join('\n');
  const pdf = `Pat Example\npat@example.com | 555-0100\nOctober 29, 2026\nRe: VP Engineering at Example Co\nDear Example Co Hiring Team,\n${wrap(p1)}\n${wrap(p2)}\nSincerely,\nPat Example`;
  assert.equal(userLetterBody(pdf, names), `${p1}\n\n${p2}`, 'wrapped lines join into their paragraph');
  // The header run into the first paragraph on one line (lines joined), and a sign-off with contact lines after it.
  const joined = `Pat Example pat@example.com | 555-0100 October 29, 2026 Re: VP Engineering at Example Co Dear Example Co Hiring Team, ${p1}\n\n${p2} Best regards,\nPat Example\npat@example.com`;
  assert.equal(userLetterBody(joined, names), `${p1}\n\n${p2}`);
  // No greeting: nothing at the start is taken; a closing "Thank you for your time." stays.
  assert.equal(userLetterBody(`${p1}\n\n${p2} Thank you for your time.`, names), `${p1}\n\n${p2} Thank you for your time.`);
  assert.equal(paragraphsFromLines('a\n\nb'), 'a\n\nb', 'text with paragraphs is left alone');
  for (const input of ['\n'.repeat(50000), ' '.repeat(50000) + 'Dear', `Dear ${'x'.repeat(50000)}`, `${'Sincerely '.repeat(5000)}`]) {
    const start = Date.now();
    userLetterBody(input, names);
    assert.ok(Date.now() - start < 1000, `${input.length} characters`);
  }
});

test('stripSalutationAndSignoff removes model-added greetings and sign-offs', () => {
  const letter = '\nDear Hiring Manager,\n\nFirst paragraph.\n\nSecond paragraph.\n\nBest regards,\nPat Example\n';
  assert.equal(stripSalutationAndSignoff(letter, ['Pat Example', 'Pat']), 'First paragraph.\n\nSecond paragraph.');
  assert.equal(stripSalutationAndSignoff('Body only.', []), 'Body only.');
});

test('checkCoverLetter reports text and same-sentence rules once each', () => {
  const rules = [
    { label: 'confident', text: '\\bi am confident\\b' },
    { label: 'wrong title at Globex', sentence: ['globex', '\\bCTO\\b'] },
    { label: 'broken', text: '(' },
  ];
  const letter = 'I led Globex engineering. I was CTO at Initech. I am confident we should talk. I am confident again.';
  assert.deepEqual(checkCoverLetter(letter, rules), ['confident']);
  assert.deepEqual(checkCoverLetter('As CTO at Globex I scaled teams.', rules), ['wrong title at Globex']);
});

test('letterDocName and letterHtml build the v1 layout safely', () => {
  assert.equal(letterDocName('Example & Co.', 'VP, Engineering', '2026-09-30'), 'Example_Co_VP_Engineering_CoverLetter_2026-09-30');
  const html = letterHtml({
    candidate: { name: 'Pat Example', contactLine: 'pat@example.com', linkedin: 'linkedin.com/in/example', signoffName: 'Pat' },
    company: 'Example <Co>',
    title: 'CTO',
    date: 'September 30, 2026',
    body: 'First paragraph\ncontinues here.\n\nSecond paragraph.',
  });
  assert.match(html, /<h1>Pat Example<\/h1>/);
  assert.match(html, /<b>Re: CTO at Example &lt;Co&gt;<\/b>/);
  assert.match(html, /<p>Dear Example &lt;Co&gt; Hiring Team,<\/p>/);
  assert.match(html, /<p>First paragraph continues here\.<\/p>\n<p>Second paragraph\.<\/p>/);
  assert.match(html, /<p>Sincerely,<\/p>\n<p>Pat<\/p>/);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
