// Adds a job you found yourself (the UI's Add job does the same).
//   npm run add -- --url=https://...                         fetch, score, write materials if 7+
//   npm run add -- --url=... --description-file=jd.txt        use a pasted description saved to a file
//   npm run add -- --title="Fractional CTO" --company="Acme" --description-file=jd.txt --track=fractional
//   options: --notes="..." --location="..." --rate="$150-$200/hr" --hours="10-15 hrs" --write-materials
import { readFileSync } from 'node:fs';
import { createClaude, createTracer } from '@scottmroth5/agent-core';
import { loadConfig } from '../tools/config.js';
import { loadKnowledge } from '../tools/knowledge.js';
import { createHttp } from '../tools/http.js';
import { createBrowser } from '../tools/browser.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { createDriveClient } from '../tools/google/drive.js';
import { openJobStore } from '../db/index.js';
import { exitWhenDone } from '../tools/exit.js';
import { addPosting } from '../agents/manual.js';

function parseArgs(argv) {
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
  const config = loadConfig();
  const store = openJobStore();
  const auth = getGoogleAuth();
  const browser = await createBrowser();
  const run = createTracer({ store }).startRun('add', { url: input.url ?? null });
  try {
    const result = await addPosting(input, {
      store,
      config,
      http: createHttp(),
      browser,
      claude: createClaude(),
      knowledge: await loadKnowledge({ auth }),
      drive: createDriveClient(auth),
      run,
      onStep: () => {}, // steps are already logged by the run
    });
    run.finish('ok', result);
    console.log(result.created ? `Added job #${result.id}: scored ${result.score}${result.promoted ? ', in your pipeline' : ''}.` : `Already saved as job #${result.id}.`);
  } catch (err) {
    run.finish('failed', { error: err.message });
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
