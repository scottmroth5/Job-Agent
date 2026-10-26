import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInline, renderMarkdown } from '../tools/markdown.js';

test('inline: bold, italic, code, links, and bare URLs', () => {
  assert.equal(renderInline('**Bold** and *italic* and _also_ and `x*y*`'), '<strong>Bold</strong> and <em>italic</em> and <em>also</em> and <code>x*y*</code>');
  assert.equal(renderInline('[Site](https://example.com/a?b=1&c=2)'), '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">Site</a>');
  assert.equal(renderInline('See https://example.com/x.'), 'See <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.');
  assert.equal(renderInline('snake_case_name and 2*3*4'), 'snake_case_name and 2*3*4', 'no italics inside words or arithmetic');
  assert.equal(renderInline('mail [me](mailto:a@example.com)'), 'mail <a href="mailto:a@example.com" target="_blank" rel="noopener noreferrer">me</a>');
});

test('safety: markup is escaped and only http, https, and mailto links are made', () => {
  assert.equal(renderInline('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(renderInline('[click](javascript:alert(1))'), '[click](javascript:alert(1))');
  assert.equal(renderInline('[x](data:text/html,hi)'), '[x](data:text/html,hi)');
  const quoted = renderInline('[x](https://e.com/"onmouseover="alert(1))');
  assert.ok(!quoted.includes('"onmouseover'), 'a quote cannot end the href early');
  assert.ok(!renderMarkdown('# <script>bad()</script>').includes('<script>'));
  assert.ok(!renderMarkdown('| <b>a</b> |\n|---|\n| <i>b</i> |').includes('<b>'));
});

test('blocks: headings, nested lists, numbered lists, tables, quotes, rules, and line breaks', () => {
  const html = renderMarkdown([
    '## Goals',
    '1. First',
    '2. Second',
    '',
    '- Parent',
    '  - Child',
    '- Next',
    '',
    '| Term | Meaning |',
    '| --- | --- |',
    '| RIS | **Scheduling** |',
    '',
    '> Quoted *line*',
    '',
    '---',
    'Line one',
    'line two',
  ].join('\n'));
  assert.equal(
    html,
    [
      '<h2>Goals</h2>',
      '<ol><li>First</li><li>Second</li></ol>',
      '<ul><li>Parent<ul><li>Child</li></ul></li><li>Next</li></ul>',
      '<table><thead><tr><th>Term</th><th>Meaning</th></tr></thead><tbody><tr><td>RIS</td><td><strong>Scheduling</strong></td></tr></tbody></table>',
      '<blockquote><p>Quoted <em>line</em></p></blockquote>',
      '<hr>',
      '<p>Line one<br>line two</p>',
    ].join('\n'),
  );
});

test('plain notes written before formatting existed still read the same', () => {
  assert.equal(renderMarkdown('Glassdoor\nApplied via referral'), '<p>Glassdoor<br>Applied via referral</p>');
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});

test('fenced blocks: shown exactly as written and escaped, and they end a paragraph', () => {
  assert.equal(
    renderMarkdown('Intro\n```\n## Not a heading\n<script>x</script> **not bold**\n```\nAfter'),
    '<p>Intro</p>\n<pre><code>## Not a heading\n&lt;script&gt;x&lt;/script&gt; **not bold**</code></pre>\n<p>After</p>',
  );
  assert.equal(renderMarkdown('```\nunclosed'), '<pre><code>unclosed</code></pre>', 'an unclosed fence runs to the end');
});
