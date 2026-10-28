// The whole job run in order: discover -> score -> hunt -> archive -> one report email.
// Each step is its own traced run; a failed step is reported in the email and later steps still run.
// The scheduler and the Run pipeline button call it, once per user (multi-user, phase 3).
//   npm run pipeline                 full run, as the owner
//   npm run pipeline -- --no-email   skip the email (prints its subject instead)
//   node scripts/pipeline.js --user=5  as user 5: their search settings, background, and Claude key. Google results
//                                    (the owner's paid search), Google Docs, and the report email are the owner's only.
import { createJobTracer } from '../tools/trace.js';
import { createJobClaude } from '../tools/claude.js';
import { loadConfig } from '../tools/config.js';
import { ownerBackground } from '../tools/knowledge.js';
import { createHttp } from '../tools/http.js';
import { createBrowser } from '../tools/browser.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { createDriveClient } from '../tools/google/drive.js';
import { assertNoRunningRun } from '../tools/runs.js';
import { openJobStore } from '../db/index.js';
import { runAsUser } from '../db/scope.js';
import { OWNER_ID } from '../db/users.js';
import { configFor, profileForAI } from '../agents/user-config.js';
import { exitWhenDone } from '../tools/exit.js';
import { runDiscovery, SOURCES } from '../agents/discovery/discover.js';
import { scorePostings, DEFAULT_SCORE_MODEL } from '../agents/discovery/score.js';
import { generateForPostings } from '../agents/hunt/generate.js';
import { archivePostings } from '../agents/hunt/archive.js';
import { collectReport, renderReport, sendReport } from '../agents/hunt/report.js';

const noEmail = process.argv.includes('--no-email');
const userArg = process.argv.find((a) => a.startsWith('--user='));
const uid = userArg ? Number(userArg.slice('--user='.length)) : OWNER_ID;
const owner = uid === OWNER_ID;

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
  if (!Number.isInteger(uid) || uid < 1) throw new Error(`--user must be a user id, not "${userArg}"`);
  const store = openJobStore(undefined, { fallbackUid: uid });
  const config = owner ? loadConfig() : configFor(store.raw, uid, null);
  if (!owner) {
    const user = store.raw.prepare('SELECT status FROM users WHERE id = ?').get(uid);
    if (user?.status !== 'active') throw new Error(`User ${uid} is not an active account.`);
    if (!config.ready) throw new Error('Set up your search (terms, title keywords, and locations) under Settings first.');
  }
  for (const name of ['pipeline', 'discover', 'score', 'hunt']) assertNoRunningRun(store.db, name);
  const tracer = createJobTracer({ store });
  const pipelineRun = tracer.startRun('pipeline');
  // Google (Docs, Drive, the report email) is the owner's sign-in; others' runs never touch it.
  const auth = owner ? getGoogleAuth() : null;
  const { serper, ...freeSources } = SOURCES;
  const browser = await createBrowser();

  try {
    await step(
      tracer,
      'discover',
      async (run) => {
        const { insertedIds, ...summary } = await runDiscovery({ store, config, http: createHttp(), browser, sources: owner ? SOURCES : freeSources, options: { log: run.log } });
        return summary;
      },
      (s) => (Object.values(s.bySource).some((x) => x.errors.length || x.rateLimited) ? 'partial' : 'ok'),
    );

    let knowledge = null;
    try {
      knowledge = owner ? await ownerBackground(store) : profileForAI(store.raw, uid);
    } catch (err) {
      pipelineRun.log('error', `Candidate Knowledge could not be loaded; scoring and letters skipped: ${err.message}`);
    }
    const claude = createJobClaude(store.db);
    if (knowledge) {
      await step(tracer, 'score', (run) => scorePostings({ store, config, claude, knowledge, model: DEFAULT_SCORE_MODEL, run }), (s) =>
        s.aborted ? 'aborted' : s.failures.length ? 'partial' : 'ok',
      );
      await step(tracer, 'hunt', (run) => generateForPostings({ store, config, claude, knowledge, drive: owner ? createDriveClient(auth) : null, run }), (s) =>
        s.aborted ? 'aborted' : s.failures.length || s.docFailures.length ? 'partial' : 'ok',
      );
    }
    await step(tracer, 'archive', async () => {
      const r = archivePostings(store.db);
      return { archived: r.archived.map(({ id, reason }) => ({ id, reason })), remaining: r.remaining };
    });
    pipelineRun.finish(knowledge ? 'ok' : 'partial');

    console.log(`[pipeline] Step ${STEPS.length}/${STEPS.length}: report`);
    // The report goes only to the owner (it is job data; others see their results in the app).
    if (noEmail || !owner) {
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

// The user's own time zone for their calendar days (read before the store is opened in main; none for the owner).
function timeZoneOf(id) {
  if (id === OWNER_ID || !Number.isInteger(id)) return null;
  const store = openJobStore(undefined, { fallbackUid: id, snapshot: false });
  try {
    return store.raw.prepare('SELECT time_zone FROM users WHERE id = ?').pluck().get(id) ?? null;
  } finally {
    store.close();
  }
}

runAsUser(uid, main, { timeZone: timeZoneOf(uid) })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(exitWhenDone);
