// The whole job run in order: discover -> score -> hunt -> archive -> one report email.
// Each step is its own traced run; a failed step is reported in the email and later steps still run.
// The scheduler and the Run pipeline button call it, once per user (multi-user, phase 3).
//   npm run pipeline                 full run, as the owner
//   npm run pipeline -- --no-email   skip the email (prints its subject instead)
//   node scripts/pipeline.js --user=5  as user 5: their search settings, background, and Claude key. Google results
//                                    (the owner's paid search), Google Docs, and the report email are the owner's only.
import { createJobTracer } from '../tools/trace.ts';
import { createJobClaude } from '../tools/claude.ts';
import { loadConfig } from '../tools/config.ts';
import { ownerBackground } from '../tools/knowledge.ts';
import { createHttp } from '../tools/http.ts';
import { createBrowser } from '../tools/browser.ts';
import { getGoogleAuth } from '../tools/google/auth.ts';
import { createDriveClient } from '../tools/google/drive.ts';
import { assertNoRunningRun } from '../tools/runs.ts';
import { openJobStore } from '../db/index.ts';
import { runAsUser } from '../db/scope.ts';
import { OWNER_ID } from '../db/users.ts';
import { configFor, profileForAI } from '../agents/user-config.ts';
import { exitWhenDone } from '../tools/exit.ts';
import { runDiscovery, SOURCES } from '../agents/discovery/discover.ts';
import { scorePostings, DEFAULT_SCORE_MODEL } from '../agents/discovery/score.ts';
import { generateForPostings } from '../agents/hunt/generate.ts';
import { archivePostings } from '../agents/hunt/archive.ts';
import { collectReport, renderReport, sendReport } from '../agents/hunt/report.ts';
/**
 * @import { Run } from '@scottmroth5/agent-core'
 * @import { OAuth2Client } from 'google-auth-library'
 * @import { JobSearchConfig } from '../tools/config.ts'
 * @import { UsersRow } from '../db/types.ts'
 */

const noEmail = process.argv.includes('--no-email');
const userArg = process.argv.find((a) => a.startsWith('--user='));
const uid = userArg ? Number(userArg.slice('--user='.length)) : OWNER_ID;
const owner = uid === OWNER_ID;

const STEPS = ['discover', 'score', 'hunt', 'archive', 'report'];

/**
 * Runs one step as its own traced run; returns its summary, or null when it failed.
 * @template {object} T
 * @param {ReturnType<typeof createJobTracer>} tracer
 * @param {string} name
 * @param {(run: Run) => Promise<T>} fn
 * @param {(summary: T) => string} [statusOf]
 * @returns {Promise<T | null>}
 */
async function step(tracer, name, fn, statusOf = (/** @type {T} */ _summary) => 'ok') {
  console.log(`[pipeline] Step ${STEPS.indexOf(name) + 1}/${STEPS.length}: ${name}`);
  const run = await tracer.startRun(name);
  try {
    const summary = await fn(run);
    await run.finish(statusOf(summary), summary);
    return summary;
  } catch (err) {
    const e = /** @type {Error} */ (err);
    run.log('error', `${name} failed: ${e.name}: ${e.message}`);
    await run.finish('failed', { error: `${e.name}: ${e.message}` });
    return null;
  }
}

async function main() {
  const started = new Date().toISOString();
  if (!Number.isInteger(uid) || uid < 1) throw new Error(`--user must be a user id, not "${userArg}"`);
  const store = openJobStore(undefined, { fallbackUid: uid });
  const config = await configFor(store.admin, uid, owner ? loadConfig() : /** @type {JobSearchConfig} */ (/** @type {unknown} */ (null))); // either way with the skipped sites from Settings; the file config is read for the owner only
  if (!owner) {
    const user = /** @type {Pick<UsersRow, 'status'> | undefined} */ (await store.admin.prepare('SELECT status FROM users WHERE id = ?').get(uid));
    if (user?.status !== 'active') throw new Error(`User ${uid} is not an active account.`);
    if (!config.ready) throw new Error('Set up your search (terms, title keywords, and locations) under Settings first.');
  }
  for (const name of ['pipeline', 'discover', 'score', 'hunt']) await assertNoRunningRun(store.db, name);
  const tracer = createJobTracer({ store });
  const pipelineRun = await tracer.startRun('pipeline');
  // Google (Docs, Drive, the report email) is the owner's sign-in; others' runs never touch it.
  const auth = owner ? getGoogleAuth() : null;
  const ownerAuth = /** @type {OAuth2Client} */ (auth); // read only where owner is true
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

    /** @type {string | null} */
    let knowledge = null;
    try {
      knowledge = owner ? await ownerBackground(store) : await profileForAI(store.admin, uid);
    } catch (err) {
      pipelineRun.log('error', `Candidate Knowledge could not be loaded; scoring and letters skipped: ${/** @type {Error} */ (err).message}`);
    }
    const claude = createJobClaude(store.db);
    if (knowledge) {
      await step(tracer, 'score', (run) => scorePostings({ store, config, claude, knowledge, model: DEFAULT_SCORE_MODEL, run }), (s) =>
        s.aborted ? 'aborted' : s.failures.length ? 'partial' : 'ok',
      );
      await step(tracer, 'hunt', (run) => generateForPostings({ store, config, claude, knowledge, drive: owner ? createDriveClient(ownerAuth) : null, run }), (s) =>
        s.aborted ? 'aborted' : s.failures.length || s.docFailures.length ? 'partial' : 'ok',
      );
    }
    await step(tracer, 'archive', async () => {
      const r = await archivePostings(store.db);
      return { archived: r.archived.map(({ id, reason }) => ({ id, reason })), remaining: r.remaining };
    });
    await pipelineRun.finish(knowledge ? 'ok' : 'partial');

    console.log(`[pipeline] Step ${STEPS.length}/${STEPS.length}: report`);
    // The report goes only to the owner (it is job data; others see their results in the app).
    if (noEmail || !owner) {
      const r = renderReport(await collectReport(store.db, { since: started }));
      console.log(`${r.subject}\n${r.text}`);
    } else {
      const to = process.env.EMAIL_ADDRESS;
      if (!to) throw new Error('EMAIL_ADDRESS is not set in .env; the report was not sent.');
      const r = await sendReport({ db: store.db, auth: ownerAuth, to, since: started });
      console.log(`Sent "${r.subject}" (${r.text}).`);
    }
  } catch (err) {
    await pipelineRun.finish('failed');
    throw err;
  } finally {
    await browser?.close();
    store.close();
  }
}

// The user's own time zone for their calendar days (read before the store is opened in main; none for the owner).
/**
 * @param {number} id
 * @returns {Promise<string | null>}
 */
async function timeZoneOf(id) {
  if (id === OWNER_ID || !Number.isInteger(id)) return null;
  const store = openJobStore(undefined, { fallbackUid: id, snapshot: false });
  try {
    return /** @type {string | null | undefined} */ (await store.admin.prepare('SELECT time_zone FROM users WHERE id = ?').pluck().get(id)) ?? null;
  } finally {
    store.close();
  }
}

runAsUser(uid, main, { timeZone: await timeZoneOf(uid) })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(exitWhenDone);
