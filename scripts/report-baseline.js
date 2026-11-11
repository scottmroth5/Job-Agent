// Prints the v3 baseline (tools/baseline.ts): counts and sizes only, never text. Read-only: no migrations, no copy.
//   npm run report:baseline             plain text
//   npm run report:baseline -- --json   the same as JSON, to keep privately (never in the repo)
import { DB_PATH } from '../db/index.ts';
import { dataPath } from '../tools/paths.ts';
import { baselineReport, renderBaseline } from '../tools/baseline.ts';

try {
  const report = await baselineReport(DB_PATH, { attachmentsDir: dataPath('attachments') });
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : renderBaseline(report));
} catch (err) {
  console.error(`baseline failed: ${/** @type {Error} */ (err).name}: ${/** @type {Error} */ (err).message}`);
  process.exitCode = 1;
}
