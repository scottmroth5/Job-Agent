// Blocks commits that contain personal data. Terms come from the gitignored config
// (privateTerms) and from every value in .env, so leaked API keys are caught too.
//
//   node scripts/check-personal.js           check staged files (what the pre-commit hook runs)
//   node scripts/check-personal.js --all     check every tracked file in the working tree
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CONFIG_PATH } from '../tools/config.js';
import { repoPath } from '../tools/paths.js';

const ENV_MIN_LENGTH = 8; // shorter .env values (flags, small numbers) would only produce noise

/**
 * Finds private terms in text. Matching is case-insensitive and whole-word where the term
 * starts and ends with a letter or digit. allowTerms are blanked out first, so a public
 * handle that contains a private word (e.g. a username containing a first name) does not trip.
 * @returns {Array<{line: number, term: number}>} 1-based line numbers and indexes into terms
 */
export function findPersonalHits(text, terms, allowTerms = []) {
  let scrubbed = text;
  for (const allow of allowTerms) {
    scrubbed = scrubbed.replace(new RegExp(escapeRegex(allow), 'gi'), (m) => ' '.repeat(m.length));
  }
  const patterns = terms.map((t) => {
    const e = escapeRegex(t.trim());
    const start = /^[\p{L}\p{N}]/u.test(t.trim()) ? '(?<![\\p{L}\\p{N}])' : '';
    const end = /[\p{L}\p{N}]$/u.test(t.trim()) ? '(?![\\p{L}\\p{N}])' : '';
    return new RegExp(`${start}${e}${end}`, 'iu');
  });
  const hits = [];
  scrubbed.split(/\r?\n/).forEach((line, i) => {
    patterns.forEach((p, term) => {
      if (p.test(line)) hits.push({ line: i + 1, term });
    });
  });
  return hits;
}

/** Shows enough of a term to recognize it without printing a secret in full. */
export function maskTerm(term) {
  return term.length <= 4 ? `${term[0]}***` : `${term.slice(0, 2)}***${term.slice(-1)} (${term.length} chars)`;
}

/** Values from a .env file. */
export function envValues(text) {
  return text
    .split(/\r?\n/)
    .map((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(l)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter((v) => v && v.length >= ENV_MIN_LENGTH);
}

/** Paths that hold personal data by design: anything under data/, and .env files. */
export function isForbiddenPath(file) {
  const f = file.replace(/\\/g, '/');
  return f.startsWith('data/') || /(^|\/)\.env(\..*)?$/.test(f);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function git(args) {
  return execFileSync('git', args, { cwd: repoPath(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const all = process.argv.includes('--all');
  if (!existsSync(CONFIG_PATH)) {
    if (process.env.CI) {
      console.warn('check-personal: no config in CI; skipping.');
      return 0;
    }
    console.error(`check-personal: ${CONFIG_PATH} is missing, so personal data cannot be checked. Run "npm run config:from-v1".`);
    return 1;
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const envPath = repoPath('.env');
  const terms = [
    ...(config.privateTerms ?? []),
    ...(existsSync(envPath) ? envValues(readFileSync(envPath, 'utf8')) : []),
  ].filter((t) => t && t.trim());
  const allowTerms = config.allowTerms ?? [];

  const files = (all ? git(['ls-files']) : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']))
    .split('\n')
    .filter(Boolean);

  // Personal folders must never be committed, even if .gitignore is ever broken.
  const forbidden = files.filter(isForbiddenPath);
  for (const file of forbidden) console.error(`  ${file}  is in a personal-data location (data/ or .env) and must never be committed`);

  let found = forbidden.length;
  for (const file of files) {
    let text;
    try {
      text = all ? readFileSync(repoPath(file), 'utf8') : git(['show', `:${file}`]);
    } catch {
      continue; // deleted in the working tree, or unreadable
    }
    if (text.includes('\u0000')) continue; // binary
    for (const hit of findPersonalHits(text, terms, allowTerms)) {
      found += 1;
      console.error(`  ${file}:${hit.line}  matches private term ${maskTerm(terms[hit.term])}`);
    }
  }

  const scope = all ? 'tracked files' : 'staged files';
  if (found) {
    console.error(`check-personal: ${found} match(es) in ${scope}. Move the value into data/config or .env and use a placeholder.`);
    return 1;
  }
  console.log(`check-personal: ${files.length} ${scope} checked against ${terms.length} private terms, no matches.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
