// Adds a job you found yourself (the UI's Add job does the same).
//   npm run add -- --url=https://...                         fetch, score, write materials if 7+
//   npm run add -- --url=... --description-file=jd.txt        use a pasted description saved to a file
//   npm run add -- --title="Fractional CTO" --company="Acme" --description-file=jd.txt --track=fractional
//   options: --notes="..." --location="..." --rate="$150-$200/hr" --hours="10-15 hrs" --write-materials
import { readFileSync } from 'node:fs';
import { createJobTracer } from '../tools/trace.ts';
import { createJobClaude } from '../tools/claude.ts';
import { loadConfig } from '../tools/config.ts';
import { configFor } from '../agents/user-config.ts';
import { OWNER_ID } from '../db/users.ts';
import { ownerBackground } from '../tools/knowledge.ts';
import { createHttp } from '../tools/http.ts';
import { createBrowser } from '../tools/browser.ts';
import { getGoogleAuth } from '../tools/google/auth.ts';
import { createDriveClient } from '../tools/google/drive.ts';
import { openJobStore } from '../db/index.ts';
import { exitWhenDone } from '../tools/exit.ts';
import { addPosting } from '../agents/manual.ts';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @param {string} name */
  const get = (name) => {
    const a = argv.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : undefined;
  };
  const file = get('description-file');
  return {
    url: get('url'),
    title: get('title'),
    company: get('company'),
    location: get('location'),
    notes: get('notes'),
    track: get('track'),
    rateText: get('rate'),
    hoursText: get('hours'),
    description: file ? readFileSync(file, 'utf8') : undefined,
    writeMaterials: argv.includes('--write-materials'),
  };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const store = openJobStore();
  const config = configFor(store.raw, OWNER_ID, loadConfig()); // with the skipped sites from Settings
  const auth = getGoogleAuth();
  const browser = await createBrowser();
  const run = createJobTracer({ store }).startRun('add', { url: input.url ?? null });
  try {
    const result = await addPosting(input, {
      store,
      config,
      http: createHttp(),
      browser,
      claude: createJobClaude(store.db),
      knowledge: await ownerBackground(store),
      drive: createDriveClient(auth),
      run,
      onStep: () => {}, // steps are already logged by the run
    });
    run.finish('ok', result);
    console.log(result.created ? `Added job #${result.id}: scored ${result.score}${result.promoted ? ', in your pipeline' : ''}.` : `Already saved as job #${result.id}.`);
  } catch (err) {
    run.finish('failed', { error: /** @type {Error} */ (err).message });
    throw err;
  } finally {
    await browser?.close();
    store.close();
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(exitWhenDone);
