// Shared by the source scans (test/user-scope.test.js, test/portable-sql.test.js): every string literal in the app's
// source files, read without running anything.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoPath } from '../../tools/paths.ts';

/** The folders that hold app code (tests, the page, and legacy are not scanned). */
export const APP_FOLDERS = ['agents', 'server', 'tools', 'demo', 'scripts', 'db', 'evals'];

/** Every string literal in JavaScript source (template literals whole, with their ${} expressions). */
/** @param {string} src */
export function stringLiterals(src) {
  const out = [];
  let i = 0;
  const readQuoted = (/** @type {string} */ q) => {
    const start = i;
    i += 1;
    while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
    i += 1;
    return src.slice(start, i);
  };
  const readTemplate = () => {
    const start = i;
    i += 1;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        let depth = 1;
        while (i < src.length && depth) {
          const c = src[i];
          if (c === '`') { readTemplate(); continue; }
          if (c === '\'' || c === '"') { readQuoted(c); continue; }
          if (c === '{') depth += 1;
          if (c === '}') depth -= 1;
          i += 1;
        }
        continue;
      }
      i += 1;
    }
    i += 1;
    return src.slice(start, i);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; if (i < 2) break; continue; }
    if (c === '\'' || c === '"') { out.push(readQuoted(c)); continue; }
    if (c === '`') { out.push(readTemplate()); continue; }
    i += 1;
  }
  return out;
}

/** @param {string} dir @returns {string[]} */
const filesIn = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === 'node_modules' || name === 'public' || name === 'fixtures') return [];
  return statSync(path).isDirectory() ? filesIn(path) : /\.(m?js|ts)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
});

/** Each app source file as { rel, literals }, rel with forward slashes from the repo root. */
export function appSources() {
  return APP_FOLDERS.flatMap((folder) => filesIn(repoPath(folder))).map((path) => ({
    rel: relative(repoPath(), path).replace(/\\/g, '/'),
    literals: stringLiterals(readFileSync(path, 'utf8')),
  }));
}
