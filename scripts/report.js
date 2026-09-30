// Sends the report email for recent runs (npm run pipeline sends it automatically).
//   npm run report                       runs from the last 24 hours
//   npm run report -- --hours=72         a longer window
//   npm run report -- --no-email         print the subject and summary instead of sending
import { openJobStore } from '../db/index.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { collectReport, renderReport, sendReport } from '../agents/hunt/report.js';

const hours = Number(process.argv.find((a) => a.startsWith('--hours='))?.split('=')[1] ?? 24);
const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
const store = openJobStore();
try {
  if (process.argv.includes('--no-email')) {
    const r = renderReport(collectReport(store.db, { since }));
    console.log(`${r.subject}\n${r.text}`);
  } else {
    const to = process.env.EMAIL_ADDRESS;
    if (!to) throw new Error('EMAIL_ADDRESS is not set in .env.');
    const r = await sendReport({ db: store.db, auth: getGoogleAuth(), to, since });
    console.log(`Sent "${r.subject}" (${r.text}).`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  store.close();
}
