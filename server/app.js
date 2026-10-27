// The Job Hunt API. Every route has a JSON schema; the OpenAPI spec at /api/openapi.json is the
// contract the UI (and any future backend rewrite) follows.
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { createJobTracer } from '../tools/trace.js';
import { listPostings, getPosting, updatePosting, summary } from './queries.js';
import { registerLookupRoutes } from './lookups-routes.js';
import { lookups } from '../agents/lookups.js';
import { funnel } from './funnel.js';
import { registerAttachmentRoutes } from './attachments.js';
import { registerPrepRoutes } from './prep-routes.js';
import { registerNoteRoutes } from './notes-routes.js';
import { createScheduler } from './scheduler.js';
import { BLOCKED_PAGE, geoBlocker } from './geo.js';
import { DEMO_REQUEST_LIMIT, errorReply, registerRateLimits, registerSecurityHeaders } from './security.js';
import { timeZone } from '../tools/dates.js';
import { createTaskRunner } from './tasks.js';
import { registerAuth } from './auth.js';
import { currentUserId, runAsUser } from '../db/scope.js';
import { OWNER_ID, touchLastSeen } from '../db/users.js';
import { registerFeedbackRoutes } from './feedback-routes.js';
import { registerHelpRoutes } from './help-routes.js';
import { registerDraftRoutes } from './draft-routes.js';
import { registerDocumentRoutes } from './document-routes.js';
import { MIN_PROFILE_CHARS, userConfig, userProfile } from '../agents/user-config.js';
import { adminWaiting } from './admin-queries.js';
import { today } from './today.js';

// Routes for admins: the Users screen and the feedback users sent (server/app.js refuses anyone else).
const ADMIN_ONLY = ['/api/admin/users', '/api/admin/feedback'];
// What a paused account may still change: resume itself (when it paused itself) or delete itself.
const PAUSED_MAY = new Set(['POST /api/account/resume', 'POST /api/account/delete']);
import { profileForAI, scheduledUsers, userConfigView } from '../agents/user-config.js';

// Routes only the owner may call: the inbox reads the owner's own Gmail (another person's would need Google's review
// of the restricted Gmail scopes), and the lists and the spending cap are shared by everyone. Everything else runs
// for the signed-in user with their own settings, background, and Claude key (agents/user-config.js, tools/claude.js).
export const OWNER_ONLY = new Set([
  'POST /api/inbox/check', 'POST /api/inbox/emails/:id/review',
  'PUT /api/admin/budget', 'POST /api/admin/lookups/:list', 'PATCH /api/admin/lookups/:list/:id', 'PUT /api/admin/lookups/:list/roles',
]);
import { registerAdminRoutes } from './admin.js';
import { registerAccountRoutes } from './account-routes.js';
import { registerPages } from './pages.js';
import { registerUserRoutes } from './users-routes.js';
import { claudeKeyWorks } from '../tools/claude.js';
import { getLayout, registerLayoutRoutes } from './layout.js';
import { registerPipelineRoutes } from './pipeline-routes.js';
import { registerInboxRoutes, registerReminderRoutes } from './inbox-routes.js';
import { addPosting } from '../agents/manual.js';
import { scorePostings, DEFAULT_SCORE_MODEL } from '../agents/discovery/score.js';
import { generateForPostings } from '../agents/hunt/generate.js';
import { resolveDetails } from '../agents/discovery/details.js';
import { jobIdFromUrl } from '../agents/discovery/sources/linkedin.js';
import * as fractionaljobs from '../agents/discovery/sources/fractionaljobs.js';
import { isOnSite } from '../tools/urls.js';
import { checkLocation } from '../tools/location.js';
import { assertNoRunningRun } from '../tools/runs.js';

const ACTIONS = ['score', 'write-materials', 'regenerate', 'refetch'];
const nullableString = { type: ['string', 'null'] };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const anyObject = { type: 'object', additionalProperties: true };
const taskAccepted = { 202: { type: 'object', properties: { taskId: { type: 'string' } } } };

/**
 * @param {object} ctx
 * @param {{db}} ctx.store
 * @param {object} ctx.config
 * @param {object} ctx.services   { claude, knowledge: () => Promise<string>, drive, http, createBrowser: () => Promise<browser|null>,
 *                                  runPipeline({ onLine }), inbox: { ready(), gmail(opts), key(), cfg } }
 * @param {string} [ctx.webDir]   built UI to serve (web/dist); skipped when missing
 * @param {string} [ctx.authMode]   'none' (default) or 'google'
 * @param {object} [ctx.auth]       { settings: authSettings(), exchange? } for google mode (tests pass a fake exchange)
 */
export async function buildApp({ store, config, services, webDir, authMode = 'none', auth = {}, logger = false, trustProxy = false, geo = {} }) {
  // trustProxy: behind a reverse proxy (Caddy in the cloud), the client's address comes from X-Forwarded-For.
  const app = Fastify({ logger, trustProxy });
  // US-only access (server/geo.js, GEO_ALLOW): refused before anything else runs; the health check always passes.
  const blocked = geoBlocker({ ...geo, log: geo.log ?? services.log ?? console });
  // Each user's own settings, background, and documents (agents/user-config.js): routes keep using config and services,
  // which answer for whoever the request runs as. The owner's are the settings file, the Google Doc, and their Drive.
  if (config) config = userConfigView(config, store.raw ?? store.db);
  const asOwner = () => (currentUserId() ?? OWNER_ID) === OWNER_ID;
  const setupOf = (uid) => {
    const raw = store.raw ?? db;
    const u = raw.prepare('SELECT name, ai_source, claude_key_enc IS NOT NULL AS has_key FROM users WHERE id = ?').get(uid);
    return { ai: u.ai_source === 'owner' || Boolean(u.has_key), aboutYou: userProfile(raw, uid).length >= MIN_PROFILE_CHARS, search: userConfig(raw, uid, u.name).ready };
  };
  const ownerDrive = services.drive;
  const ownerKnowledge = services.knowledge;
  services = {
    ...services,
    get drive() {
      return asOwner() ? ownerDrive : null; // others' letters and preps stay in the app (no access to their Drive yet)
    },
    knowledge: async () => (asOwner() ? ownerKnowledge?.() : profileForAI(store.raw ?? store.db, currentUserId())),
  };
  app.addHook('onRequest', async (req, reply) => {
    if (blocked(req)) return reply.code(403).type('text/html').header('Cache-Control', 'no-store').send(BLOCKED_PAGE);
  });
  const { db } = store;
  const tasks = createTaskRunner();
  // The demo shows a few finished runs on the Activity tab; they replay recorded output and call nothing.
  for (const sample of services.sampleTasks ?? []) {
    tasks.start(sample.kind, sample.meta ?? {}, async (step, { logger }) => {
      for (const entry of sample.output) {
        if (entry.step) step(entry.step);
        else logger[entry.level ?? 'info'](entry.text);
      }
      return sample.result ?? null;
    });
  }

  // Every route, for the test that checks each one needs sign-in.
  const routes = [];
  app.addHook('onRoute', (r) => routes.push({ method: r.method, url: r.url }));
  app.decorate('routeList', routes);

  await app.register(swagger, {
    openapi: { info: { title: 'Job Agent API', version: '1.0.0', description: 'Job Hunt UI backend' } },
  });
  registerSecurityHeaders(app, { https: Boolean(auth.settings?.publicUrl?.startsWith('https://')) });
  // A ceiling on every route per address (@fastify/rate-limit): far above normal use, it stops floods and scripted
  // abuse. The health check is exempt. The tighter limits for sign-in, refused requests, and the demo follow
  // (server/security.js).
  await app.register(fastifyRateLimit, {
    global: true,
    max: authMode === 'none' ? 6000 : 600,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/healthz',
    errorResponseBuilder: (req, ctx) => ({ statusCode: 429, error: 'Too many requests from this address. Try again later.', retryAfter: Math.ceil(ctx.ttl / 1000) }),
  });
  if (authMode !== 'none') registerRateLimits(app, { now: auth.now, all: authMode === 'demo' ? DEMO_REQUEST_LIMIT : null });
  registerAuth(app, { mode: authMode, settings: auth.settings, exchange: auth.exchange, now: auth.now, db, notices: services.notices ?? {} });
  // Multi-user (db/scope.js): each route handler, and every task it starts, runs as the signed-in user; with no sign-in
  // (AUTH_MODE none, and the demo) that is the owner. The user is decided, and refused if inactive or not allowed this
  // route, as soon as auth has run (onRequest, before the body is read); the handler runs as them from preHandler, after
  // the body, which arrives in socket events that would not carry the context. A signed-out request on an open path
  // (/auth/*, /healthz) gets no user, so a query on a user table there throws instead of reading anyone's rows.
  // auth.js has already sent anyone without an active or paused account to request access or wait.
  app.addHook('onRequest', async (req, reply) => {
    if (authMode === 'google' && !req.account) return;
    const account = authMode === 'google' ? req.account : { uid: OWNER_ID, status: 'active', role: 'admin' };
    const route = `${req.method} ${req.routeOptions.url}`;
    if (account.status === 'paused' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !PAUSED_MAY.has(route)) {
      return reply.code(403).send({ error: 'Your account is paused: you can look, but not change anything.' });
    }
    if (account.uid !== OWNER_ID && OWNER_ONLY.has(route)) return reply.code(403).send({ error: 'Only the owner can do this for now.' });
    if (account.role !== 'admin' && ADMIN_ONLY.some((p) => String(req.routeOptions.url ?? '').startsWith(p))) {
      return reply.code(403).send({ error: 'Only an admin can do this.' });
    }
    req.uid = account.uid;
    req.role = account.role;
    // Their own time zone for calendar days (the owner always uses the app's).
    req.timeZone = account.uid === OWNER_ID ? null : (db.prepare('SELECT time_zone FROM users WHERE id = ?').pluck().get(account.uid) ?? null);
    if (authMode === 'google') touchLastSeen(db, account.uid);
  });
  app.addHook('preHandler', (req, reply, done) => (req.uid ? runAsUser(req.uid, done, { timeZone: req.timeZone }) : done()));
  app.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true }));

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = errorReply(err, req, services.log ?? console);
    reply.code(status).send(body);
  });

  /** Runs a background action as a traced task; refuses while a pipeline step is running. */
  const startTask = (kind, meta, fn) => {
    for (const name of ['pipeline', 'discover', 'score', 'hunt']) {
      try {
        assertNoRunningRun(db, name);
      } catch (err) {
        throw Object.assign(new Error(`${err.message} Try again when it finishes.`), { statusCode: 409 });
      }
    }
    return tasks.start(kind, meta, async (step, { logger }) => {
      // A tracer per task, so the run's log lines also go to the task's output (the Activity tab).
      const run = createJobTracer({ store, logger }).startRun(`ui-${kind}`, meta);
      const browser = services.createBrowser ? await services.createBrowser() : null;
      try {
        const result = await fn(step, { run, browser });
        run.finish('ok', result && typeof result === 'object' ? { ...result, materials: undefined } : null);
        return result;
      } catch (err) {
        run.finish('failed', { error: err.message });
        throw err;
      } finally {
        await browser?.close?.();
      }
    });
  };

  const notFound = (reply) => reply.code(404).send({ error: 'Job not found' });

  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.get(
    '/api/funnel',
    {
      schema: {
        summary: 'Application funnel: applied, responded, interview, offer; rates, timing, by source, per week, waiting for a reply',
        querystring: { type: 'object', properties: { days: { type: 'string', enum: ['30', '90', 'all'] }, track: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' } } },
        response: { 200: anyObject },
      },
    },
    async (req) => funnel(db, { days: !req.query.days || req.query.days === 'all' ? null : Number(req.query.days), track: req.query.track && req.query.track !== 'all' ? req.query.track : null }),
  );

  app.get('/api/summary', { schema: { summary: 'Counts, the Today list, fractional target, spend, and saved layouts', response: { 200: anyObject } } }, async (req) => ({
    ...summary(db, config),
    // Home's Today list: reminders due, offers, and follow-ups (server/today.js).
    today: today(db).items,
    layout: getLayout(db),
    // A new user's setup (the Home checklist): AI paid for, About you long enough, search complete.
    ...(req.uid && req.uid !== OWNER_ID ? { setup: setupOf(req.uid) } : {}),
    // What waits for an admin (the Admin tile's count): requests for access and open feedback.
    ...(req.role === 'admin' && authMode !== 'demo' ? { adminWaiting: adminWaiting(db) } : {}),
  }));

  app.get(
    '/api/postings',
    {
      schema: {
        summary: 'List jobs',
        querystring: {
          type: 'object',
          properties: {
            track: { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: "'all' or a track ID (GET /api/lookups)" },
            stage: { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: "'all' or a stage ID" },
            status: { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: "'all', 'active' (Needs action), 'progress' (In progress), or a status ID" },
            q: { type: 'string', maxLength: 200 },
            discoveredAfter: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Only jobs discovered on or after this date (YYYY-MM-DD)' },
            needsDescription: { type: 'boolean', description: 'Only new jobs judged 7+ from the title that still need a pasted description' },
            minScore: { type: 'integer', minimum: 1, maximum: 10 },
            limit: { type: 'integer', minimum: 1, maximum: 2000 },
          },
        },
        response: { 200: { type: 'array', items: anyObject } },
      },
    },
    async (req) => {
      const lk = lookups(db);
      const special = { status: ['all', 'active', 'progress'], stage: ['all'], track: ['all'] };
      for (const list of ['status', 'stage', 'track']) {
        const v = req.query[list];
        if (v && !special[list].includes(v) && !lk.get(list, v)) throw Object.assign(new Error(`Unknown ${list} "${v}".`), { statusCode: 400 });
      }
      return listPostings(db, req.query, config);
    },
  );

  app.get('/api/postings/:id', { schema: { summary: 'Job detail', params: idParams, response: { 200: anyObject } } }, async (req, reply) => {
    const job = getPosting(db, req.params.id, config);
    // Its next steps (open reminders, an offer, a follow-up due): the panel's Next step box (server/today.js).
    return job ? { ...job, nextSteps: today(db, { jobId: job.id }).items } : notFound(reply);
  });

  app.patch(
    '/api/postings/:id',
    {
      schema: {
        summary: 'Edit a job: status, notes, dates, stage, track (fractional), company, title, pay, hours, description, or archive it as a duplicate',
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            status: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
            stage: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
            track: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
            notes: { ...nullableString, maxLength: 20000 },
            appliedOn: { anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }, { type: 'string', maxLength: 0 }] },
            title: { type: 'string', maxLength: 300 },
            duplicateOf: { type: 'integer', minimum: 1, description: 'Archive this job as a copy of that one' },
            company: { type: 'string', maxLength: 300 },
            location: { ...nullableString, maxLength: 300 },
            description: { ...nullableString, maxLength: 100000 },
            rateText: { ...nullableString, maxLength: 200 },
            hoursText: { ...nullableString, maxLength: 200 },
          },
        },
        response: { 200: anyObject },
      },
    },
    async (req, reply) => updatePosting(db, req.params.id, req.body, config) ?? notFound(reply),
  );

  app.post(
    '/api/postings',
    {
      schema: {
        summary: 'Add a job manually (runs in the background; poll the task)',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', maxLength: 2000 },
            title: { type: 'string', maxLength: 300 },
            company: { type: 'string', maxLength: 300 },
            location: { type: 'string', maxLength: 300 },
            description: { type: 'string', maxLength: 100000 },
            notes: { type: 'string', maxLength: 20000 },
            track: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
            rateText: { type: 'string', maxLength: 200 },
            hoursText: { type: 'string', maxLength: 200 },
            writeMaterials: { type: 'boolean' },
          },
        },
        response: taskAccepted,
      },
    },
    async (req, reply) => {
      const input = Object.fromEntries(Object.entries(req.body ?? {}).filter(([, v]) => v !== ''));
      const taskId = startTask('add', { url: input.url ?? null }, async (step, { run, browser }) =>
        addPosting(input, {
          store,
          config,
          http: services.http,
          browser,
          claude: services.claude,
          knowledge: await services.knowledge(),
          drive: services.drive,
          run,
          onStep: step,
        }),
      );
      return reply.code(202).send({ taskId });
    },
  );

  app.post(
    '/api/postings/:id/actions/:action',
    {
      schema: {
        summary: 'Run an action on a job: score, write-materials, regenerate, refetch',
        params: { type: 'object', required: ['id', 'action'], properties: { id: { type: 'integer', minimum: 1 }, action: { type: 'string', enum: ACTIONS } } },
        response: taskAccepted,
      },
    },
    async (req, reply) => {
      const { id, action } = req.params;
      const posting = db.prepare('SELECT * FROM postings WHERE id = ? AND user_id = @uid').get(id);
      if (!posting) return notFound(reply);
      const taskId = startTask(action, { id }, async (step, { run, browser }) => {
        if (action === 'score') {
          step('Scoring');
          const s = await scorePostings({ store, config, claude: services.claude, knowledge: await services.knowledge(), model: DEFAULT_SCORE_MODEL, run, options: { ids: [id], rescore: true } });
          if (s.failures.length) throw new Error(s.failures[0].error);
          step(s.promoted.includes(id) ? 'Scored and moved to your pipeline' : 'Scored');
          return { scored: s.scored, promoted: s.promoted.includes(id) };
        }
        if (action === 'write-materials' || action === 'regenerate') {
          if (posting.stage === 'discovered') db.prepare("UPDATE postings SET stage = 'pipeline', updated_at = ? WHERE id = ? AND user_id = @uid").run(new Date().toISOString(), id);
          const hasScore = db.prepare("SELECT 1 FROM scores WHERE posting_id = ? AND user_id = @uid AND source IN ('v2', 'v2-rule')").get(id);
          const knowledge = await services.knowledge();
          if (!hasScore) {
            step('Scoring first');
            await scorePostings({ store, config, claude: services.claude, knowledge, model: DEFAULT_SCORE_MODEL, run, options: { ids: [id], rescore: true } });
          }
          step(action === 'regenerate' ? 'Writing new resume tweaks and cover letter' : 'Writing resume tweaks and cover letter');
          const g = await generateForPostings({ store, config, claude: services.claude, knowledge, drive: services.drive, run, options: { ids: [id], regenerate: action === 'regenerate' } });
          if (g.failures.length) throw new Error(g.failures[0].error);
          step(g.docs ? 'Cover letter saved as a Google Doc' : 'Done');
          return { tweaks: g.tweaks, letters: g.letters, docs: g.docs, flagged: g.flagged };
        }
        // refetch
        step('Fetching the posting text');
        const item = { url: posting.url, title: posting.title, company: posting.company, location: posting.location, linkedinJobId: jobIdFromUrl(posting.url) };
        if (isOnSite(posting.url, 'fractionaljobs.io', '/jobs/')) item.fetchDetails = (h) => fractionaljobs.fetchPosting(h, posting.url);
        await resolveDetails(item, { http: services.http, browser });
        const ok = item.fetchStatus === 'ok';
        db.prepare(`UPDATE postings SET fetched_text = COALESCE(@text, fetched_text), fetched_at = CASE WHEN @text IS NULL THEN fetched_at ELSE @now END,
            fetch_status = @status, fetch_method = @method, fetch_attempts = fetch_attempts + 1, location = COALESCE(location, @location),
            location_check = @check, updated_at = @now WHERE id = @id AND user_id = @uid`).run({
          id,
          text: ok ? item.description : null,
          status: item.fetchStatus,
          method: item.fetchMethod ?? null,
          location: item.location ?? null,
          check: checkLocation({ location: posting.location ?? item.location, workplace: posting.workplace ?? item.workplace, text: ok ? item.description : posting.fetched_text }, config.search.homeLocations),
          now: new Date().toISOString(),
        });
        step(ok ? 'Posting text updated' : `Could not read the posting (${item.fetchStatus}); paste the description instead`);
        return { fetchStatus: item.fetchStatus };
      });
      return reply.code(202).send({ taskId });
    },
  );

  registerAdminRoutes(app, { db, config });
  registerLayoutRoutes(app, { db });
  registerAccountRoutes(app, { db, demo: authMode === 'demo', checkKey: services.checkClaudeKey ?? claudeKeyWorks, notices: services.notices ?? {}, ...(services.attachmentsDir ? { attachmentsDir: services.attachmentsDir } : {}) });
  // The Users screen never exists in the demo.
  if (authMode !== 'demo') registerUserRoutes(app, { db, notices: services.notices ?? {}, ...(services.attachmentsDir ? { attachmentsDir: services.attachmentsDir } : {}) });
  registerFeedbackRoutes(app, { db, notices: services.notices ?? {}, admin: authMode !== 'demo' });
  registerHelpRoutes(app, { store, services });
  registerDraftRoutes(app, { store, services });
  registerDocumentRoutes(app, { db, config });
  registerPages(app);
  registerLookupRoutes(app, { db });
  registerAttachmentRoutes(app, { db, dir: services.attachmentsDir });
  registerPrepRoutes(app, { store, config, services, startTask });
  registerNoteRoutes(app, { db });
  let scheduler = null;
  const scheduled = (name) => scheduler?.status().find((j) => j.name === name) ?? null;
  const pipeline = services.runPipeline ? registerPipelineRoutes(app, { db, tasks, runPipeline: services.runPipeline, schedule: () => scheduled('pipeline') }) : null;
  const inboxChecks = services.inbox ? registerInboxRoutes(app, { store, tasks, claude: services.claude, inbox: services.inbox }) : null;
  registerReminderRoutes(app, { db });

  // The encrypted backup as a task (scheduled), the same script as npm run backup, in its own process.
  const startBackup = () =>
    tasks.start('backup', { by: 'schedule' }, async (step, { logger }) => {
      step('Backing up');
      const { code, lastError } = await services.runScript({ script: 'scripts/backup.js', onLine: (l) => logger.info(l), onError: (l) => logger.error(l) });
      if (code !== 0) throw new Error(lastError ? `The backup failed: ${lastError}` : `The backup failed with exit code ${code}.`);
      step('Backup done');
    });

  // The monthly restore test as a task (scheduled), the same script as npm run backup:test, in its own process.
  const startRestoreTest = () =>
    tasks.start('restore-test', { by: 'schedule' }, async (step, { logger }) => {
      step('Testing the newest backup');
      const { code, lastError } = await services.runScript({ script: 'scripts/backup-verify.js', onLine: (l) => logger.info(l), onError: (l) => logger.error(l) });
      if (code !== 0) throw new Error(lastError ? `The restore test failed: ${lastError}` : `The restore test failed with exit code ${code}.`);
      step('Restore test passed');
    });

  // The in-app scheduler (server/scheduler.js): each job starts the same task as its button, and waits for it.
  if (services.schedules?.length) {
    const HOURS = 3600 * 1000;
    const finish = async (taskId, hours) => {
      const t = await tasks.wait(taskId, hours * HOURS);
      if (t?.status === 'failed') throw new Error(t.error ?? 'failed');
    };
    const runners = {
      pipeline: pipeline && (async () => {
        await finish(pipeline.start({ by: 'schedule' }), 4);
        // Then the inbox, as the Windows scheduled run did; a pipeline failure above skips it.
        if (inboxChecks && services.inbox.ready()) await finish(inboxChecks.startCheck({ by: 'schedule' }), 1);
        // Then each user who asked to be on the schedule, one at a time, each as themselves; one user's failure never
        // stops the next or marks the owner's run failed.
        for (const uid of scheduledUsers(store.raw ?? db)) {
          const timeZone = db.prepare('SELECT time_zone FROM users WHERE id = ?').pluck().get(uid) ?? null;
          await runAsUser(uid, () => finish(pipeline.start({ by: 'schedule' }), 4), { timeZone }).catch((err) => (services.log ?? console).warn?.(`[schedule] pipeline for user ${uid}: ${err.message}`));
        }
      }),
      inbox: inboxChecks && (() => finish(inboxChecks.startCheck({ by: 'schedule' }), 1)),
      backup: services.runScript && (() => finish(startBackup(), 1)),
      'restore-test': services.runScript && (() => finish(startRestoreTest(), 1)),
    };
    // The owner's runs: the schedule is theirs (users' scheduled runs follow it).
    const lastRanAt = (name) => () => db.prepare('SELECT started_at FROM runs WHERE name = ? AND (user_id IS NULL OR user_id = 1) ORDER BY id DESC LIMIT 1').pluck().get(name) ?? null;
    scheduler = createScheduler({
      // Scheduled jobs are the owner's (phase 1); each user's own schedule comes with per-user feeds.
      jobs: services.schedules.filter((j) => runners[j.name]).map((j) => ({ ...j, run: () => runAsUser(OWNER_ID, runners[j.name]), lastRanAt: lastRanAt(j.name) })),
      log: services.log ?? console,
      // A failed scheduled job emails the owner (server/alerts.js); the next success clears it.
      onResult: services.alerts ? (name, ok, error) => services.alerts.jobResult(name, ok, error) : null,
    });
    app.addHook('onReady', async () => {
      scheduler.start();
    });
    app.addHook('onClose', async () => scheduler.stop());
  }

  app.get('/api/schedule', { schema: { summary: 'The scheduled jobs, their schedules, and when each runs next (empty when none are set)', response: { 200: anyObject } } }, async () => ({
    timeZone: timeZone(),
    jobs: scheduler?.status() ?? [],
  }));

  app.get('/api/tasks', { schema: { summary: 'Recent background tasks, newest first (without output)', response: { 200: { type: 'array', items: anyObject } } } }, async (req) =>
    tasks.list({ uid: req.uid ?? 0 }),
  );

  app.get(
    '/api/tasks/:id/log',
    {
      schema: {
        summary: "A task's output lines from index 'from' on",
        params: { type: 'object', properties: { id: { type: 'string' } } },
        querystring: { type: 'object', properties: { from: { type: 'integer', minimum: 0 } } },
        response: { 200: anyObject },
      },
    },
    async (req, reply) => tasks.log(req.params.id, req.query.from ?? 0, { uid: req.uid ?? 0 }) ?? reply.code(404).send({ error: 'Task not found' }),
  );

  app.get(
    '/api/tasks/:id',
    { schema: { summary: 'Progress of a background action', params: { type: 'object', properties: { id: { type: 'string' } } }, response: { 200: anyObject } } },
    async (req, reply) => tasks.get(req.params.id, { uid: req.uid ?? 0 }) ?? reply.code(404).send({ error: 'Task not found' }),
  );

  if (webDir && existsSync(webDir)) {
    // wildcard (the default) serves whatever is in web/dist now, so rebuilding the UI needs no restart.
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
    );
  }

  app.decorate('tasks', tasks);
  return app;
}
