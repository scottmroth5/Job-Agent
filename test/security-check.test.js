// The static security check (scripts/security-check.js) passes on the code as it is, and catches what it guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { securityProblems } from '../scripts/security-check.js';

test('the code passes the security check', () => {
  assert.deepEqual(securityProblems(), []);
});

test('it catches raw HTML in the web page, stray child processes, request-built redirects, and control characters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sec-'));
  try {
    mkdirSync(join(dir, 'web', 'src'), { recursive: true });
    mkdirSync(join(dir, 'server'), { recursive: true });
    writeFileSync(
      join(dir, 'web', 'src', 'Bad.jsx'),
      [
        'el.innerHTML = note;',
        "setTimeout('go()', 5);",
        "const f = new Function('x', body);",
        'const y = eval(input);',
        '<p>Rerun the scoring eval (npm run eval:score) after a change.</p>',
        '<div dangerouslySetInnerHTML={{ __html: job.notes }} />',
        '<div dangerouslySetInnerHTML={{ __html: renderMarkdown(job.notes) }} />',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'server', 'bad.js'), "import { exec } from 'node:child_process';\nreturn reply.redirect(req.query.next);\nconst s = 'a\u0007b';\n");
    const problems = securityProblems(dir);
    const rules = problems.map((p) => p.rule);
    for (const r of [
      'web page: innerHTML assignment',
      'web page: a string passed to a timer',
      'web page: new Function',
      'web page: dangerouslySetInnerHTML with anything but renderMarkdown(...)',
      'child_process outside the known places',
      'a redirect straight from the request',
      'a raw control character in the source',
    ]) {
      assert.ok(rules.includes(r), r);
    }
    assert.equal(problems.filter((p) => p.rule.includes('dangerouslySetInnerHTML')).length, 1, 'renderMarkdown output is allowed');
    assert.deepEqual(problems.filter((p) => p.rule === 'web page: eval').map((p) => p.line), [4], 'eval( is caught; the word in text is not');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
