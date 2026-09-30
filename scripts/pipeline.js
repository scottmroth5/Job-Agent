// The whole job run in order: discover -> score -> hunt -> archive -> one report email.
// Each step is its own traced run; a failed step is reported in the email and later steps still run.
// This is what the scheduler (Phase 3) will call.
//   npm run pipeline                 full run
//   npm run pipeline -- --no-email   skip the email (prints its subject instead)
import { createClaude, createTracer } from '@scottmroth5/agent-core';
import { loadConfig } from '../tools/config.js';
import { loadKnowledge } from '../tools/knowledge.js';
import { createHttp } from '../tools/http.js';
import { createBrowser } from '../tools/browser.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { createDriveClient } from '../tools/google/drive.js';
import { assertNoRunningRun } from '../tools/runs.js';
import { openJobStore } from '../db/index.js';
import { runDiscovery } from '../agents/discovery/discover.js';
import { scorePostings, DEFAULT_SCORE_MODEL } from '../agents/discovery/score.js';
import { generateForPostings } from '../agents/hunt/generate.js';
import { archivePostings } from '../agents/hunt/archive.js';
import { collectReport, renderReport, sendReport } from '../agents/hunt/report.js';

const noEmail = process.argv.includes('--no-email');

const STEPS = ['discover', 'score', 'hunt', 'archive', 'report'];

/** Runs one step as its own traced run; returns its summary, or null when it failed. */
async function step(tracer, name, fn, statusOf = () => 'ok') {
  console.log(`[pipeline] Step ${STEPS.indexOf(name) + 1}/${STEPS.length}: ${name}`);
  const run = tracer.startRun(name);
  try {
    const summary = await fn(run);
    run.finish(statusOf(summary), summary);
    return summary;
  } catch (err) {
    run.log('error', `${name} failed: ${err.name}: ${err.message}`);
    run.finish('failed', { error: `${err.name}: ${err.message}` });
    return null;
  }
}

async function main() {
  const started = new Date().toISOString();
  const config = loadConfig();
  const store = openJobStore();
  for (const name of ['pipeline', 'discover', 'score', 'hunt']) assertNoRunningRun(store.db, name);
  const tracer = createTracer({ store });
  const pipelineRun = tracer.startRun('pipeline');
  const auth = getGoogleAuth();
  const browser = await createBrowser();

  try {
    await step(
      tracer,
      'discover',
      async (run) => {
        const { insertedIds, ...summary } = await runDiscovery({ store, config, http: createHttp(), browser, options: { log: run.log } });
        return summary;
      },
      (s) => (Object.values(s.bySource).some((x) => x.errors.length || x.rateLimited) ? 'partial' : 'ok'),
    );

    let knowledge = null;
    try {
      knowledge = await loadKnowledge({ auth });
    } catch (err) {
      pipelineRun.log('error', `Candidate Knowledge could not be loaded; scoring and letters skipped: ${err.message}`);
    }
    const claude = createClaude();
    if (knowledge) {
      await step(tracer, 'score', (run) => scorePostings({ store, config, claude, knowledge, model: DEFAULT_SCORE_MODEL, run }), (s) =>
        s.aborted ? 'aborted' : s.failures.length ? 'partial' : 'ok',
      );
      await step(tracer, 'hunt', (run) => generateForPostings({ store, config, claude, knowledge, drive: createDriveClient(auth), run }), (s) =>
        s.aborted ? 'aborted' : s.failures.length || s.docFailures.length ? 'partial' : 'ok',
      );
    }
    await step(tracer, 'archive', async () => {
      const r = archivePostings(store.db);
      return { archived: r.archived.map(({ id, reason }) => ({ id, reason })), remaining: r.remaining };
    });
    pipelineRun.finish(knowledge ? 'ok' : 'partial');

    console.log(`[pipeline] Step ${STEPS.length}/${STEPS.length}: report`);
    if (noEmail) {
      const r = renderReport(collectReport(store.db, { since: started }));
      console.log(`${r.subject}\n${r.text}`);
    } else {
      const to = process.env.EMAIL_ADDRESS;
      if (!to) throw new Error('EMAIL_ADDRESS is not set in .env; the report was not sent.');
      const r = await sendReport({ db: store.db, auth, to, since: started });
      console.log(`Sent "${r.subject}" (${r.text}).`);
    }
  } catch (err) {
    pipelineRun.finish('failed');
    throw err;
  } finally {
    await browser?.close();
    store.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
