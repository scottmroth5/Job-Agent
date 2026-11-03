// Prints the v3 baseline (tools/baseline.js): counts and sizes only, never text. Read-only: no migrations, no copy.
//   npm run report:baseline             plain text
//   npm run report:baseline -- --json   the same as JSON, to keep privately (never in the repo)
import { DB_PATH } from '../db/index.js';
import { dataPath } from '../tools/paths.js';
import { baselineReport, renderBaseline } from '../tools/baseline.js';

try {
  const report = baselineReport(DB_PATH, { attachmentsDir: dataPath('attachments') });
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : renderBaseline(report));
} catch (err) {
  console.error(`baseline failed: ${err.name}: ${err.message}`);
  process.exitCode = 1;
}
