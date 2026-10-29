// One-time: seal the email text in the inbox review cases written before cases were sealed
// (data/evals/inbox/review-cases.jsonl). Each plain body becomes bodyEnc (EMAIL_ENC_KEY); "not a job email" cases keep
// none. The file is replaced only after the new text is written in full. Prints counts only.
//   npm run inbox:seal-cases -- --dry-run      counts, no change
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { loadKey } from '../agents/inbox/crypto.js';
import { REVIEW_CASES_PATH, sealCaseLines } from '../agents/inbox/review.js';

const dryRun = process.argv.includes('--dry-run');
const fileArg = process.argv.find((a) => a.startsWith('--file='));
const path = fileArg ? fileArg.slice('--file='.length) : REVIEW_CASES_PATH;

if (!existsSync(path)) {
  console.log('[seal-cases] no review cases file; nothing to do');
  process.exit(0);
}
const { text, counts } = sealCaseLines(readFileSync(path, 'utf8'), loadKey());
console.log(`[seal-cases] ${counts.cases} cases: ${counts.sealed} bodies sealed, ${counts.dropped} dropped (not job email)${dryRun ? ' (dry run, nothing changed)' : ''}`);
if (!dryRun && counts.sealed + counts.dropped > 0) {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
