// A static security check of the code (npm run check:security; also run by the test suite and CI). Fast and
// deterministic, it guards the rules the app relies on against script injection and unsafe code:
//   - the web page never writes raw HTML or runs strings as code: dangerouslySetInnerHTML only ever receives
//     renderMarkdown(...) (tools/markdown.js escapes everything first), and there is no innerHTML, outerHTML,
//     insertAdjacentHTML, document.write, eval, new Function, or string timers
//   - the Content-Security-Policy keeps scripts to the app's own files only (no 'unsafe-inline', 'unsafe-eval', data:)
//   - child processes are started only from the known places, each with fixed commands
//   - the server never builds a redirect or a file path straight from a request parameter
//   - no raw control characters hide in the source
// CodeQL (CI) does the deeper analysis; this catches the obvious regressions on every run, offline.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_SECURITY_POLICY } from '../server/security.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = ['node_modules', '.git', 'data', 'legacy', 'dist'];
const files = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (SKIP.includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(m?js|jsx)$/.test(name)) out.push(p);
  }
  return out;
};

const BROWSER_SINKS = [
  [/\.innerHTML\s*[+]?=/, 'innerHTML assignment'],
  [/\.outerHTML\s*[+]?=/, 'outerHTML assignment'],
  [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
  [/document\.write(ln)?\s*\(/, 'document.write'],
  [/(^|[^.\w$])eval\(/, 'eval'],
  [/new\s+Function\s*\(/, 'new Function'],
  [/set(Timeout|Interval)\s*\(\s*['"`]/, 'a string passed to a timer'],
  [/createContextualFragment\s*\(/, 'createContextualFragment'],
];

// Where a child process may start, and why: each runs fixed commands, never text from a request.
const CHILD_PROCESS_ALLOWED = {
  'server/index.js': 'runs scripts/pipeline.js and scripts/backup.js as their own processes',
  'scripts/check-personal.js': 'reads staged files from git in the pre-commit hook',
  'scripts/evals.js': 'runs the eval scripts',
  'tools/google/oauth-flow.js': 'opens the browser for the one-time Google sign-in on the owner computer',
};

/** Every problem found: [{ file, line, rule }]. */
export function securityProblems(root = ROOT) {
  const problems = [];
  for (const file of files(root)) {
    const rel = relative(root, file).replaceAll('\\', '/');
    if (rel === 'scripts/security-check.js' || rel.startsWith('test/')) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const add = (i, rule) => problems.push({ file: rel, line: i + 1, rule });
    lines.forEach((text, i) => {
      // Raw control characters hide in code (write them as \u escapes); tab and the line ending are fine.
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) add(i, 'a raw control character in the source');
      if (rel.startsWith('web/')) {
        for (const [re, rule] of BROWSER_SINKS) if (re.test(text)) add(i, `web page: ${rule}`);
        if (/dangerouslySetInnerHTML/.test(text) && !/dangerouslySetInnerHTML=\{\{\s*__html:\s*renderMarkdown\(/.test(text)) {
          add(i, 'web page: dangerouslySetInnerHTML with anything but renderMarkdown(...)');
        }
      }
      if (/\bchild_process\b/.test(text) && !CHILD_PROCESS_ALLOWED[rel]) add(i, 'child_process outside the known places');
      if (rel.startsWith('server/') && /reply\.redirect\(\s*req\.(query|params|body|headers)/.test(text)) add(i, 'a redirect straight from the request');
      if (rel.startsWith('server/') && /(readFileSync|createReadStream|sendFile)\(\s*[^)]*req\.(query|params|body)/.test(text)) add(i, 'a file path straight from the request');
    });
  }
  const scriptSrc = /script-src ([^;]*)/.exec(CONTENT_SECURITY_POLICY)?.[1]?.trim();
  if (scriptSrc !== "'self'") problems.push({ file: 'server/security.js', line: 0, rule: `CSP script-src must be 'self' only (is ${scriptSrc})` });
  if (!/object-src 'none'/.test(CONTENT_SECURITY_POLICY) || !/base-uri 'none'/.test(CONTENT_SECURITY_POLICY) || !/frame-ancestors 'none'/.test(CONTENT_SECURITY_POLICY)) {
    problems.push({ file: 'server/security.js', line: 0, rule: "CSP must keep object-src, base-uri and frame-ancestors 'none'" });
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = securityProblems();
  for (const p of problems) console.log(`${p.file}:${p.line}  ${p.rule}`);
  console.log(`check-security: ${problems.length ? `${problems.length} problem(s)` : 'nothing found'}`);
  process.exit(problems.length ? 1 : 0);
}
