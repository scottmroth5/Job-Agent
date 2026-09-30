import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleTypeText, formatAnalysis, stripSalutationAndSignoff, checkCoverLetter, letterDocName, letterHtml } from '../agents/hunt/letters.js';
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
