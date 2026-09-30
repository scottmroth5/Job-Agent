// Builds data/config/job-search.json from the v1 Script Properties export in
// data/v1-export/prompts/*.txt. Prints field names and counts only, never values.
// Refuses to overwrite an existing config; delete it first to regenerate.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_PATH, validateConfig } from '../tools/config.js';
import { repoPath } from '../tools/paths.js';

const EXPORT_DIR = repoPath('data', 'v1-export', 'prompts');

const list = (s) =>
  String(s ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * Builds the config object from v1 property values ({ NAME: value }).
 * privateTerms is seeded with every personal value found; employer names are pulled from
 * the plain-word alternatives in COVER_LETTER_CHECKS sentence rules (e.g. "acme|globex").
 */
export function buildConfig(props) {
  const checks = props.COVER_LETTER_CHECKS ? JSON.parse(props.COVER_LETTER_CHECKS) : [];
  const name = props.CONTACT_NAME?.trim() ?? '';
  const contactParts = String(props.CONTACT_LINE ?? '')
    .split(/[|•·,]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  const employers = checks
    .filter((r) => Array.isArray(r.sentence))
    .flatMap((r) => r.sentence[0].split('|'))
    .map((t) => t.replace(/\\b/g, '').trim())
    .filter((t) => /^[A-Za-z]{4,}$/.test(t));

  const privateTerms = [
    name,
    ...name.split(/\s+/).filter((p) => p.length >= 4),
    props.SIGNOFF_NAME?.trim(),
    ...contactParts,
    props.CONTACT_LINKEDIN?.trim(),
    props.EMAIL_ADDRESS?.trim(),
    ...list(props.HOME_LOCATIONS),
    ...employers,
    props.YOUR_KNOWLEDGE_DOC_ID?.trim(),
    props.COVER_LETTER_FOLDER_ID?.trim(),
    props.DISCOVERED_SHEET_ID?.trim(),
    props.JOB_HUNT_SHEET_ID?.trim(),
  ].filter((t) => t && t.length >= 3);

  return {
    candidate: {
      name,
      signoffName: props.SIGNOFF_NAME?.trim() || name,
      contactLine: props.CONTACT_LINE?.trim() ?? '',
      linkedin: props.CONTACT_LINKEDIN?.trim() ?? '',
    },
    search: {
      terms: list(props.SEARCH_TERMS),
      relevantTitleKeywords: list(props.RELEVANT_TITLE_KEYWORDS),
      noiseTitleKeywords: list(props.NOISE_TITLE_KEYWORDS),
      homeLocations: list(props.HOME_LOCATIONS),
    },
    coverLetterChecks: checks,
    privateTerms: [...new Set(privateTerms.map((t) => t.toLowerCase()))],
    allowTerms: ['scottmroth5'],
  };
}

function main() {
  if (existsSync(CONFIG_PATH)) {
    console.error(`${CONFIG_PATH} already exists. Delete it first to regenerate from the v1 export.`);
    return 1;
  }
  if (!existsSync(EXPORT_DIR)) {
    console.error(`No v1 export found at ${EXPORT_DIR}.`);
    return 1;
  }
  const names = [
    'CONTACT_NAME', 'SIGNOFF_NAME', 'CONTACT_LINE', 'CONTACT_LINKEDIN', 'EMAIL_ADDRESS',
    'SEARCH_TERMS', 'RELEVANT_TITLE_KEYWORDS', 'NOISE_TITLE_KEYWORDS', 'HOME_LOCATIONS',
    'COVER_LETTER_CHECKS', 'YOUR_KNOWLEDGE_DOC_ID', 'COVER_LETTER_FOLDER_ID',
    'DISCOVERED_SHEET_ID', 'JOB_HUNT_SHEET_ID',
  ];
  const props = {};
  for (const n of names) {
    const file = join(EXPORT_DIR, `${n}.txt`);
    if (existsSync(file)) props[n] = readFileSync(file, 'utf8').trim();
  }
  const config = buildConfig(props);
  const problems = validateConfig(config);
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  console.log(`Wrote ${CONFIG_PATH}`);
  console.log(`  search terms: ${config.search.terms.length}, relevant keywords: ${config.search.relevantTitleKeywords.length}, ` +
    `noise keywords: ${config.search.noiseTitleKeywords.length}, home locations: ${config.search.homeLocations.length}`);
  console.log(`  cover letter checks: ${config.coverLetterChecks.length}, private terms: ${config.privateTerms.length}`);
  console.log(`  missing from export: ${names.filter((n) => !(n in props)).join(', ') || 'none'}`);
  if (problems.length) console.log(`  needs attention:\n  - ${problems.join('\n  - ')}`);
  console.log('Next: open the file, check privateTerms, and add any employer or other names it missed.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
