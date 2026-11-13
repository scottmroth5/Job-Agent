// The Job Hunt API. Every route has a JSON schema; the OpenAPI spec at /api/openapi.json is the
// contract the UI (and any future backend rewrite) follows.
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { createJobTracer } from '../tools/trace.ts';
import { listPostings, getPosting, updatePosting, summary } from './queries.ts';
import { registerLookupRoutes } from './lookups-routes.ts';
import { lookups } from '../agents/lookups.ts';
import { funnel } from './funnel.ts';
import { registerAttachmentRoutes } from './attachments.ts';
import { registerPrepRoutes } from './prep-routes.ts';
import { registerNoteRoutes } from './notes-routes.ts';
import { createScheduler, parseSchedule } from './scheduler.ts';
import { BLOCKED_PAGE, geoBlocker } from './geo.ts';
import { registerUsageTotals } from './usage-totals.ts';
import { DEMO_REQUEST_LIMIT, errorReply, registerRateLimits, registerSecurityHeaders } from './security.ts';
import { timeZone } from '../tools/dates.ts';
import { createTaskRunner } from './tasks.ts';
import { registerAuth } from './auth.ts';
import { currentUserId, runAsUser } from '../db/scope.ts';
import { OWNER_ID, touchLastSeen } from '../db/users.ts';
import { registerFeedbackRoutes } from './feedback-routes.ts';
import { registerHelpRoutes } from './help-routes.ts';
import { registerDraftRoutes } from './draft-routes.ts';
import { registerDocumentRoutes } from './document-routes.ts';
import { registerLetterRoutes } from './letter-routes.ts';
import { MIN_PROFILE_CHARS, userConfig, userProfile } from '../agents/user-config.ts';
import { adminWaiting } from './admin-queries.ts';
import { today } from './today.ts';
import type { FastifyError, FastifyServerOptions } from 'fastify';
import type { Claude } from '@scottmroth5/agent-core';
import type { JobStore } from '../db/index.ts';
import type { Http } from '../tools/http.ts';
import type { UserConfig } from '../agents/user-config.ts';
import type { PostingsRow } from '../db/types.ts';
import type { JobItem, PageRenderer } from '../agents/discovery/types.ts';
import type { ManualInput } from '../agents/manual.ts';
import type { PostingFilters, PostingPatch } from './queries.ts';
import type { Schedule, ScheduledJob } from './scheduler.ts';
import type { AutomationHooks } from './account-routes.ts';
import type { CountryOf } from './geo.ts';
import type { Place } from './usage-totals.ts';
import type { AuthSettings, Exchange } from './auth.ts';
import type { createAlerts } from './alerts.ts';
import type { InboxServices } from './inbox-routes.ts';
import type { RunPipeline } from './pipeline-routes.ts';
import type { Account, App, FastifyReply, IdParams, Notices, RouteServices, StartTask, Tasks } from './types.ts';

/** A browser for pages that need JavaScript (tools/browser.ts), closed when its task ends. */
type Browser = PageRenderer & { close?: () => Promise<unknown> };
/** Runs a script as its own process (server/main.ts). */
export type RunScript = (opts: { script: string; args?: string[]; onLine: (line: string) => void; onError?: (line: string) => void }) => Promise<{ code: number; lastError: string | null }>;
/** A finished run the demo replays on the Activity tab (demo/sample-data.ts SAMPLE_TASKS). */
type SampleTask = { kind: string; meta?: object; output: Array<{ step?: string; level?: string; text?: string }>; result?: unknown };
type ServerLog = { info?: (text: string) => void; warn?: (text: string) => void; error?: (text: string) => void };

/** What buildApp runs with: server/main.ts builds the real ones (or the demo's); tests pass fakes and leave most out. */
export type AppServices = Omit<RouteServices, 'knowledge'> & {
  /** Tests only: a stand-in for the owner's knowledge doc (buildApp reads everyone's from Settings). */
  knowledge?: (() => Promise<string>) | null;
  /** null only in the demo. */
  http: Http | null;
  createBrowser?: (() => Promise<Browser | null>) | null;
  runScript?: RunScript;
  runPipeline?: RunPipeline;
  /** The .env schedules: backup and restore-test run as they are; pipeline and inbox are the owner's defaults (agents/automation.ts). */
  schedules?: Array<{ name: string; schedule: Schedule }>;
  /** Tests only: how long a due run waits before trying again while another holds the lock, and how often automatic runs resync. */
  scheduleRetryMs?: number;
  automationSyncMs?: number;
  inbox?: InboxServices;
  notices?: Notices;
  alerts?: ReturnType<typeof createAlerts>;
  log?: ServerLog;
  sampleTasks?: SampleTask[];
  checkClaudeKey?: (apiKey: string) => Promise<boolean>;
  attachmentsDir?: string;
};

/** buildApp's app with what it decorates: the task runner, and every route (test/security.test.js walks it). */
export type BuiltApp = App & { tasks: Tasks; routeList: Array<{ method: string | string[]; url: string }> };

export type BuildAppOptions = {
  store: JobStore;
  config: UserConfig;
  services: AppServices;
  /** The built UI to serve (web/dist); skipped when missing. */
  webDir?: string;
  /** 'none' (default), 'google', or 'demo'. */
  authMode?: string;
  /** For google mode: authSettings(), and a fake exchange in tests. */
  auth?: { settings?: Partial<AuthSettings>; exchange?: Exchange; now?: () => number };
  logger?: boolean;
  /** As TRUST_PROXY gives it; Fastify also takes a hop count, which its types leave out. */
  trustProxy?: FastifyServerOptions['trustProxy'] | number;
  geo?: { allow?: string[]; lookup?: CountryOf | null; log?: ServerLog | null };
  usage?: { location?: ((ip: string) => Place | null) | null; siteHost?: string | null; demoHost?: string | null; now?: () => Date };
};

// Routes for admins: the Users screen and the feedback users sent (server/app.ts refuses anyone else).
const ADMIN_ONLY = ['/api/admin/users', '/api/admin/feedback', '/api/admin/usage'];
// What a paused account may still change: resume itself (when it paused itself) or delete itself.
const PAUSED_MAY = new Set(['POST /api/account/resume', 'POST /api/account/delete']);
import { backgroundFor, userConfigView, withUserConfig } from '../agents/user-config.ts';
import { automatedUsers, automationFor, skipArgs } from '../agents/automation.ts';
import { dismissScam, scamFor } from '../agents/discovery/scam.ts';
import type { AutomationDefaults } from '../agents/automation.ts';

// Routes only the owner may call: the inbox reads the owner's own Gmail (another person's would need Google's review
// of the restricted Gmail scopes), and the lists and the spending cap are shared by everyone. Everything else runs
// for the signed-in user with their own settings, background, and Claude key (agents/user-config.ts, tools/claude.ts).
export const OWNER_ONLY = new Set([
  'POST /api/inbox/check', 'POST /api/inbox/emails/:id/review',
  'PUT /api/admin/budget', 'POST /api/admin/lookups/:list', 'PATCH /api/admin/lookups/:list/:id', 'PUT /api/admin/lookups/:list/roles',
]);
import { registerAdminRoutes } from './admin.ts';
import { registerAccountRoutes } from './account-routes.ts';
import { registerResumeRoutes } from './resume-routes.ts';
import { registerPages } from './pages.ts';
import { registerUserRoutes } from './users-routes.ts';
import { claudeKeyWorks } from '../tools/claude.ts';
import { getLayout, registerLayoutRoutes } from './layout.ts';
import { registerPipelineRoutes } from './pipeline-routes.ts';
import { registerExcludedSiteRoutes } from './excluded-sites-routes.ts';
import { registerFollowUpRoutes } from './follow-up-routes.ts';
import { staleDays } from '../agents/follow-ups.ts';
import { registerInboxRoutes, registerReminderRoutes } from './inbox-routes.ts';
import { addPosting } from '../agents/manual.ts';
import { scorePostings, DEFAULT_SCORE_MODEL } from '../agents/discovery/score.ts';
import { generateForPostings } from '../agents/hunt/generate.ts';
import { resolveDetails } from '../agents/discovery/details.ts';
import { jobIdFromUrl } from '../agents/discovery/sources/linkedin.ts';
import * as fractionaljobs from '../agents/discovery/sources/fractionaljobs.ts';
import { isOnSite } from '../tools/urls.ts';
import { checkLocation } from '../tools/location.ts';
import { assertNoRunningRun } from '../tools/runs.ts';

const ACTIONS = ['score', 'write-materials', 'regenerate', 'refetch'];
const nullableString = { type: ['string', 'null'] };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const anyObject = { type: 'object', additionalProperties: true };
const taskAccepted = { 202: { type: 'object', properties: { taskId: { type: 'string' } } } };

export async function buildApp({ store, config, services: given, webDir, authMode = 'none', auth = {}, logger = false, trustProxy = false, geo = {}, usage = {} }: BuildAppOptions) {
  // trustProxy: behind a reverse proxy (Caddy in the cloud), the client's address comes from X-Forwarded-For.
  const app = Fastify({ logger, trustProxy: trustProxy as FastifyServerOptions['trustProxy'] });
  // US-only access (server/geo.ts, GEO_ALLOW): refused before anything else runs; the health check always passes.
  const blocked = geoBlocker({ ...geo, log: geo.log ?? given.log ?? console });
  // Each user's own settings, background, and documents (agents/user-config.ts): routes keep using config and services,
  // which answer for whoever the request runs as. The owner's are the settings file, the Google Doc, and their Drive.
  const ownerConfig = config;
  if (config) config = userConfigView(config, store.admin);
  const asOwner = () => (currentUserId() ?? OWNER_ID) === OWNER_ID;
  const setupOf = async (uid: number) => {
    const raw = store.admin;
    // A signed-in user has a row; a null name goes to userConfig as it always has.
    const u = await raw.prepare('SELECT name, ai_source, claude_key_enc IS NOT NULL AS has_key FROM users WHERE id = ?').get(uid) as { name: string; ai_source: string; has_key: number };
    return { ai: u.ai_source === 'owner' || Boolean(u.has_key), aboutYou: (await userProfile(raw, uid)).length >= MIN_PROFILE_CHARS, search: (await userConfig(raw, uid, u.name)).ready };
  };
  const ownerDrive = given.drive;
  const testKnowledge = given.knowledge; // tests only: a stand-in for the owner's knowledge doc
  const services: AppServices & RouteServices = {
    ...given,
    get drive() {
      return asOwner() ? ownerDrive : null; // others' letters and preps stay in the app (no access to their Drive yet)
    },
    // The knowledge doc from Settings, the current user's.
    // Not the owner means there is a current user.
    knowledge: async () => backgroundFor(store.admin, asOwner() ? OWNER_ID : (currentUserId() as number), { fallback: testKnowledge ?? null }),
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
        else logger[(entry.level ?? 'info') as 'info' | 'warn' | 'error'](entry.text); // the samples use these levels
      }
      return sample.result ?? null;
    });
  }

  // Every route, for the test that checks each one needs sign-in.
  const routes: Array<{ method: string | string[]; url: string }> = [];
  app.addHook('onRoute', (r) => {
    routes.push({ method: r.method, url: r.url });
  });
  app.decorate('routeList', routes);

  await app.register(swagger, {
    openapi: { info: { title: 'Job Agent API', version: '1.0.0', description: 'Job Hunt UI backend' } },
  });
  const analytics = authMode === 'demo' ? auth.settings?.analytics : null; // the demo's PostHog host, else none
  registerSecurityHeaders(app, { https: Boolean(auth.settings?.publicUrl?.startsWith('https://')), connect: analytics ? [analytics.host] : [] });
  // A ceiling on every route per address (@fastify/rate-limit): far above normal use, it stops floods and scripted
  // abuse. The health check is exempt. The tighter limits for sign-in, refused requests, and the demo follow
  // (server/security.ts).
  await app.register(fastifyRateLimit, {
    global: true,
    max: authMode === 'none' ? 6000 : 600,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/healthz',
    errorResponseBuilder: (req, ctx) => ({ statusCode: 429, error: 'Too many requests from this address. Try again later.', retryAfter: Math.ceil(ctx.ttl / 1000) }),
  });
  if (authMode !== 'none') registerRateLimits(app, { now: auth.now, all: authMode === 'demo' ? DEMO_REQUEST_LIMIT : null });
  registerAuth(app, { mode: authMode, settings: auth.settings, exchange: auth.exchange, now: auth.now, db, notices: services.notices ?? {} });
  // The admin's usage totals (server/usage-totals.ts): the signed-in app only, never the demo or a local run. Google
  // mode always has its settings (assertSafeBinding).
  if (authMode === 'google') {
    registerUsageTotals(app, { db: store.admin, location: usage.location, ownOrigin: new URL((auth.settings as AuthSettings).publicUrl).origin, siteHost: usage.siteHost, demoHost: usage.demoHost, now: usage.now });
  }
  // Multi-user (db/scope.ts): each route handler, and every task it starts, runs as the signed-in user; with no sign-in
  // (AUTH_MODE none, and the demo) that is the owner. The user is decided, and refused if inactive or not allowed this
  // route, as soon as auth has run (onRequest, before the body is read); the handler runs as them from preHandler, after
  // the body, which arrives in socket events that would not carry the context. A signed-out request on an open path
  // (/auth/*, /healthz) gets no user, so a query on a user table there throws instead of reading anyone's rows.
  // auth.js has already sent anyone without an active or paused account to request access or wait.
  app.addHook('onRequest', async (req, reply) => {
    if (authMode === 'google' && !req.account) return;
    const account: Account = authMode === 'google' ? (req.account as Account) : { uid: OWNER_ID, status: 'active', role: 'admin' }; // checked above
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
    req.timeZone = account.uid === OWNER_ID ? null : ((await db.prepare('SELECT time_zone FROM users WHERE id = ?').pluck().get(account.uid) as string | null | undefined) ?? null);
    if (authMode === 'google') await touchLastSeen(db, account.uid);
  });
  // The route runs as its user, with their settings loaded first, so `config` answers from them at once.
  app.addHook('preHandler', (req, reply, done) => {
    const uid = req.uid;
    if (!uid) return done();
    runAsUser(
      uid,
      () => {
        if (!ownerConfig) return done();
        void withUserConfig(store.admin, uid, ownerConfig, () => done()).catch((err: Error) => done(err));
      },
      { timeZone: req.timeZone },
    );
  });
  app.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true }));

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = errorReply(err as FastifyError, req, services.log ?? console);
    reply.code(status).send(body);
  });

  /** Runs a background action as a traced task; refuses while a pipeline step is running. */
  const startTask: StartTask = async (kind, meta, fn) => {
    for (const name of ['pipeline', 'discover', 'score', 'hunt']) {
      try {
        await assertNoRunningRun(db, name);
      } catch (err) {
        throw Object.assign(new Error(`${(err as Error).message} Try again when it finishes.`), { statusCode: 409 });
      }
    }
    return tasks.start(kind, meta, async (step, { logger }) => {
      // A tracer per task, so the run's log lines also go to the task's output (the Activity tab).
      const run = await createJobTracer({ store, logger }).startRun(`ui-${kind}`, meta);
      const browser = services.createBrowser ? await services.createBrowser() : null;
      try {
        const result = await fn(step, { run, browser });
        await run.finish('ok', result && typeof result === 'object' ? { ...result, materials: undefined } : null);
        return result;
      } catch (err) {
        await run.finish('failed', { error: (err as Error).message });
        throw err;
      } finally {
        await browser?.close?.();
      }
    });
  };

  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Job not found' });

  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.get<{ Querystring: { days?: '30' | '90' | 'all'; track?: string } }>(
    '/api/funnel',
    {
      schema: {
        summary: 'Application funnel: applied, responded, interview, offer; rates, timing, by source, per week, waiting for a reply',
        querystring: { type: 'object', properties: { days: { type: 'string', enum: ['30', '90', 'all'] }, track: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' } } },
        response: { 200: anyObject },
      },
    },
    async (req) => await funnel(db, { days: !req.query.days || req.query.days === 'all' ? null : Number(req.query.days), track: req.query.track && req.query.track !== 'all' ? req.query.track : null, staleDays: await staleDays(db) }),
  );

  app.get('/api/summary', { schema: { summary: 'Counts, the Today list, fractional target, spend, and saved layouts', response: { 200: anyObject } } }, async (req) => ({
    ...await summary(db, config),
    // Home's Today list: reminders due, offers, and follow-ups (server/today.ts).
    today: (await today(db)).items,
    layout: await getLayout(db),
    // A new user's setup (the Home checklist): AI paid for, About you long enough, search complete.
    ...(req.uid && req.uid !== OWNER_ID ? { setup: await setupOf(req.uid) } : {}),
    // What waits for an admin (the Admin tile's count): requests for access and open feedback.
    ...(req.role === 'admin' && authMode !== 'demo' ? { adminWaiting: await adminWaiting(store.admin) } : {}),
  }));

  app.get<{ Querystring: PostingFilters & { needsDescription?: boolean; minScore?: number; limit?: number } }>(
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
      const lk = await lookups(db);
      const special: Record<string, string[]> = { status: ['all', 'active', 'progress'], stage: ['all'], track: ['all'] };
      for (const list of ['status', 'stage', 'track'] as const) {
        const v = req.query[list];
        if (v && !special[list].includes(v) && !lk.get(list, v)) throw Object.assign(new Error(`Unknown ${list} "${v}".`), { statusCode: 400 });
      }
      return await listPostings(db, req.query, config);
    },
  );

  app.get<{ Params: IdParams }>('/api/postings/:id', { schema: { summary: 'Job detail', params: idParams, response: { 200: anyObject } } }, async (req, reply) => {
    const job = await getPosting(db, req.params.id, config);
    // Its next steps (open reminders, an offer, a follow-up due): the panel's Next step box (server/today.ts).
    return job ? { ...job, nextSteps: (await today(db, { jobId: job.id })).items } : notFound(reply);
  });

  app.patch<{ Params: IdParams; Body: PostingPatch }>(
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
    async (req, reply) => await updatePosting(db, req.params.id, req.body, config) ?? notFound(reply),
  );

  app.post<{ Body: ManualInput }>(
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
      if (!services.claude) return reply.code(503).send({ error: 'AI is not available here.' });
      const input: ManualInput = Object.fromEntries(Object.entries(req.body ?? {}).filter(([, v]) => v !== ''));
      const taskId = await startTask('add', { url: input.url ?? null }, async (step, { run, browser }) =>
        addPosting(input, {
          store,
          config,
          // null only in the demo, which refuses this route (server/auth.ts); claude was checked above.
          http: services.http as Http,
          browser,
          claude: services.claude as Claude,
          knowledge: await services.knowledge(),
          drive: services.drive,
          run,
          onStep: step,
        }),
      );
      return reply.code(202).send({ taskId });
    },
  );

  app.post<{ Params: { id: number; action: 'score' | 'write-materials' | 'regenerate' | 'refetch' } }>(
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
      const posting = await db.prepare('SELECT * FROM postings WHERE id = ? AND user_id = @uid').get(id) as PostingsRow | undefined;
      if (!posting) return notFound(reply);
      if (action !== 'refetch' && !services.claude) return reply.code(503).send({ error: 'AI is not available here.' });
      // Checked above for the actions that use it.
      const claude = services.claude as Claude;
      const taskId = await startTask(action, { id }, async (step, { run, browser }) => {
        if (action === 'score') {
          step('Scoring');
          const s = await scorePostings({ store, config, claude, knowledge: await services.knowledge(), model: DEFAULT_SCORE_MODEL, run, options: { ids: [id], rescore: true } });
          if (s.failures.length) throw new Error(s.failures[0].error);
          step(s.promoted.includes(id) ? 'Scored and moved to your pipeline' : 'Scored');
          return { scored: s.scored, promoted: s.promoted.includes(id) };
        }
        if (action === 'write-materials' || action === 'regenerate') {
          const lk = await lookups(db);
          if (lk.groupOf('stage', posting.stage) === 'found') await db.prepare('UPDATE postings SET stage = ?, updated_at = ? WHERE id = ? AND user_id = @uid').run(lk.role('stage', 'promote'), new Date().toISOString(), id);
          const hasScore = await db.prepare("SELECT 1 FROM scores WHERE posting_id = ? AND user_id = @uid AND source IN ('v2', 'v2-rule')").get(id);
          const knowledge = await services.knowledge();
          if (!hasScore) {
            step('Scoring first');
            await scorePostings({ store, config, claude, knowledge, model: DEFAULT_SCORE_MODEL, run, options: { ids: [id], rescore: true } });
          }
          step(action === 'regenerate' ? 'Writing new resume tweaks and cover letter' : 'Writing resume tweaks and cover letter');
          const g = await generateForPostings({ store, config, claude, knowledge, drive: services.drive, run, options: { ids: [id], regenerate: action === 'regenerate' } });
          if (g.failures.length) throw new Error(g.failures[0].error);
          step(g.docs ? 'Cover letter saved as a Google Doc' : 'Done');
          return { tweaks: g.tweaks, letters: g.letters, checked: g.checked, claimFlags: g.claimFlags, docs: g.docs, flagged: g.flagged };
        }
        // refetch
        step('Fetching the posting text');
        // resolveDetails reads these and fills in the text and fetch fields.
        const item = { url: posting.url, title: posting.title, company: posting.company, location: posting.location, linkedinJobId: jobIdFromUrl(posting.url) } as JobItem;
        if (isOnSite(posting.url, 'fractionaljobs.io', '/jobs/')) item.fetchDetails = (h) => fractionaljobs.fetchPosting(h, posting.url as string); // on the site, so it has a url
        await resolveDetails(item, { http: services.http as Http, browser });
        const ok = item.fetchStatus === 'ok';
        await db.prepare(`UPDATE postings SET fetched_text = COALESCE(@text, fetched_text), fetched_at = CASE WHEN CAST(@text AS TEXT) IS NULL THEN fetched_at ELSE @now END,
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
  // Each user's automatic runs (agents/automation.ts): the defaults are the .env schedules; the scheduler below fills in
  // sync (after a save) and next (a user's next runs, for Settings).
  const envSpec = (name: string) => services.schedules?.find((j) => j.name === name)?.schedule.spec ?? null;
  const automationHooks: AutomationHooks & { defaults: AutomationDefaults } = {
    defaults: { pipeline: envSpec('pipeline'), inbox: envSpec('inbox') },
    sync: async () => {},
    next: () => ({ pipeline: null, inbox: null }),
  };
  registerAccountRoutes(app, { db, automation: automationHooks, demo: authMode === 'demo', checkKey: services.checkClaudeKey ?? claudeKeyWorks, notices: services.notices ?? {}, ...(services.attachmentsDir ? { attachmentsDir: services.attachmentsDir } : {}) });
  // The Users screen never exists in the demo.
  if (authMode !== 'demo') registerUserRoutes(app, { db, adminDb: store.admin, notices: services.notices ?? {}, ...(services.attachmentsDir ? { attachmentsDir: services.attachmentsDir } : {}) });
  registerFeedbackRoutes(app, { db, adminDb: store.admin, notices: services.notices ?? {}, admin: authMode !== 'demo' });
  registerHelpRoutes(app, { store, services });
  registerDraftRoutes(app, { store, services });
  registerDocumentRoutes(app, { db, config });
  registerLetterRoutes(app, { store, config, services });
  registerPages(app);
  registerLookupRoutes(app, { db });
  registerAttachmentRoutes(app, { db, dir: services.attachmentsDir });
  registerResumeRoutes(app, { db }); // after attachments, which registers the raw-file body parser
  registerPrepRoutes(app, { store, config, services, startTask });
  registerNoteRoutes(app, { db });
  // Not a scam (or undo): the job's scam warning stops showing (agents/discovery/scam.ts). The job is the user's own.
  app.post<{ Params: IdParams; Body: { dismissed?: boolean } }>(
    '/api/postings/:id/scam/dismiss',
    {
      schema: {
        summary: 'Mark a job "Not a scam" (dismissed false shows its warning again)',
        params: idParams,
        body: { type: ['object', 'null'], additionalProperties: false, properties: { dismissed: { type: 'boolean' } } },
        response: { 200: anyObject },
      },
    },
    async (req, reply) => {
      if (!(await dismissScam(db, req.params.id, req.body?.dismissed !== false))) return reply.code(404).send({ error: 'This job has no scam check.' });
      return { scam: await scamFor(db, req.params.id) };
    },
  );
  registerExcludedSiteRoutes(app, { db, ownerConfig });
  registerFollowUpRoutes(app, { store, config, services, startTask, demo: authMode === 'demo' });
  let scheduler: ReturnType<typeof createScheduler> | null = null;
  // Each user's automatic runs (agents/automation.ts) by job name: the owner's are "pipeline" and "inbox" (the names
  // the alerts and the runs table know), anyone else's "pipeline:<id>". automaticOn is who has them on.
  const automaticOn = new Set<number>();
  const jobOf = (uid: number, kind: 'pipeline' | 'inbox') => (uid === OWNER_ID ? kind : `${kind}:${uid}`);
  const statusOf = (name: string) => scheduler?.status().find((j) => j.name === name) ?? null;
  const pipeline = services.runPipeline
    ? registerPipelineRoutes(app, {
        db,
        tasks,
        runPipeline: services.runPipeline,
        schedule: (uid) => {
          const job = statusOf(jobOf(uid, 'pipeline'));
          // The demo shows its sample candidate's automatic runs as on (account-routes.ts DEMO_AUTOMATION).
          return { automatic: authMode === 'demo' || automaticOn.has(uid), next: job?.next ?? null, schedule: job?.schedule ?? null };
        },
      })
    : null;
  const inboxChecks = services.inbox ? registerInboxRoutes(app, { store, tasks, claude: services.claude, inbox: services.inbox }) : null;
  registerReminderRoutes(app, { db });

  // The encrypted backup as a task (scheduled), the same script as npm run backup, in its own process.
  const startBackup = () =>
    tasks.start('backup', { by: 'schedule' }, async (step, { logger }) => {
      step('Backing up');
      // Scheduled only with runScript (the runners below).
      const { code, lastError } = await (services.runScript as RunScript)({ script: 'scripts/backup.js', onLine: (l) => logger.info(l), onError: (l) => logger.error(l) });
      if (code !== 0) throw new Error(lastError ? `The backup failed: ${lastError}` : `The backup failed with exit code ${code}.`);
      step('Backup done');
    });

  // The monthly restore test as a task (scheduled), the same script as npm run backup:test, in its own process.
  const startRestoreTest = () =>
    tasks.start('restore-test', { by: 'schedule' }, async (step, { logger }) => {
      step('Testing the newest backup');
      const { code, lastError } = await (services.runScript as RunScript)({ script: 'scripts/backup-verify.js', onLine: (l) => logger.info(l), onError: (l) => logger.error(l) });
      if (code !== 0) throw new Error(lastError ? `The restore test failed: ${lastError}` : `The restore test failed with exit code ${code}.`);
      step('Restore test passed');
    });

  // The in-app scheduler (server/scheduler.ts): each job starts the same task as its button, and waits for it. The
  // backup and the restore test come from .env; pipelines and inbox checks are each user's automatic runs, synced
  // from their settings at start, after each save, and every few minutes (so a pause or a deleted account drops out).
  if (authMode !== 'demo' && (pipeline || inboxChecks || services.schedules?.length)) {
    const HOURS = 3600 * 1000;
    const log = services.log ?? console;
    const retryMs = services.scheduleRetryMs ?? 60 * 1000;
    const finish = async (taskId: string, hours: number) => {
      const t = await tasks.wait(taskId, hours * HOURS);
      if (t?.status === 'failed') throw new Error(t.error ?? 'failed');
    };
    // One scheduled pipeline or inbox check at a time, in the order they came due: each waits for the one before it.
    let queue: Promise<unknown> = Promise.resolve();
    const inQueue = <T>(fn: () => Promise<T>): Promise<T> => {
      const result = queue.then(fn);
      queue = result.catch(() => {});
      return result;
    };
    // A start refused because another pipeline or inbox check is running (a button press) waits and tries again,
    // for up to 4 hours, instead of being lost.
    const whenFree = async (start: () => Promise<string>) => {
      const until = Date.now() + 4 * HOURS;
      for (;;) {
        try {
          return await start();
        } catch (err) {
          if ((err as { statusCode?: number }).statusCode !== 409 || Date.now() + retryMs > until) throw err;
          await new Promise((r) => setTimeout(r, retryMs));
        }
      }
    };
    const asUser = async (uid: number, fn: () => Promise<unknown>) => {
      if (uid === OWNER_ID) return await runAsUser(OWNER_ID, async () => (ownerConfig ? await withUserConfig(store.admin, OWNER_ID, ownerConfig, fn) : await fn()));
      const timeZone = ((await store.admin.prepare('SELECT time_zone FROM users WHERE id = ?').pluck().get(uid)) as string | null | undefined) ?? null;
      return await runAsUser(uid, fn, { timeZone });
    };
    // The user's settings when a run comes due, so a pause or a save since the last sync wins; null: run nothing.
    const current = async (uid: number) => {
      if ((await store.admin.prepare('SELECT status FROM users WHERE id = ?').pluck().get(uid)) !== 'active') return null;
      const a = await automationFor(store.admin, uid, automationHooks.defaults);
      return a.on ? a : null;
    };
    const pipelineRun = (uid: number) => async () => {
      if (!pipeline) return;
      const run = inQueue(async () => {
        // Read when its turn comes, so turning automatic runs off while it waits in the queue still stops it.
        const a = await current(uid);
        if (!a) return;
        await asUser(uid, async () => {
          await finish(await whenFree(() => pipeline.start({ by: 'schedule', args: skipArgs(a.steps) })), 4);
          // Then the owner's inbox, as the Windows scheduled run did; a pipeline failure above skips it.
          if (uid === OWNER_ID && a.inbox?.afterPipeline && inboxChecks && (services.inbox as InboxServices).ready()) await finish(await whenFree(() => inboxChecks.startCheck({ by: 'schedule' })), 1);
        });
      });
      // Another user's failure is logged, never emailed to the owner (server/alerts.ts hears only the owner's jobs).
      if (uid === OWNER_ID) await run;
      else await run.catch((err: Error) => log.warn?.(`[schedule] pipeline for user ${uid}: ${err.message}`));
    };
    const inboxRun = async () => {
      if (!inboxChecks) return;
      await inQueue(async () => {
        const a = await current(OWNER_ID);
        if (!a?.inbox?.schedule) return;
        await asUser(OWNER_ID, async () => finish(await whenFree(() => inboxChecks.startCheck({ by: 'schedule' })), 1));
      });
    };
    // When a job last started, from the runs table; the owner's include runs from before runs had a user.
    const lastRanAt = (name: string, uid = OWNER_ID) => async () =>
      ((await store.admin
        .prepare(`SELECT started_at FROM runs WHERE name = ? AND (user_id = ? OR (? = ${OWNER_ID} AND user_id IS NULL)) ORDER BY id DESC LIMIT 1`)
        .pluck()
        .get(name, uid, uid)) as string | null | undefined) ?? null;
    const appRunners: Record<string, (() => Promise<unknown>) | null | undefined> = {
      backup: services.runScript && (() => finish(startBackup(), 1)),
      'restore-test': services.runScript && (() => finish(startRestoreTest(), 1)),
    };
    const jobsScheduler = createScheduler({
      // The backup and the restore test are the app's, run as the owner (their runs are the owner's).
      jobs: (services.schedules ?? [])
        .filter((j) => appRunners[j.name])
        .map((j) => ({ ...j, run: async () => await asUser(OWNER_ID, appRunners[j.name] as () => Promise<unknown>), lastRanAt: lastRanAt(j.name) })),
      log,
      // A failed scheduled job of the owner's emails the owner (server/alerts.ts); the next success clears it. Another
      // user's jobs ("pipeline:<id>") never reach the alerts: job data goes to nobody but its own user.
      onResult: services.alerts ? (name, ok, error) => (name.includes(':') ? undefined : (services.alerts as ReturnType<typeof createAlerts>).jobResult(name, ok, error)) : null,
    });
    scheduler = jobsScheduler;

    let synced = new Set<string>();
    const sync = async () => {
      const on = await automatedUsers(store.admin, automationHooks.defaults);
      const want = new Map<string, ScheduledJob>();
      for (const { uid, automation: a } of on) {
        if (pipeline && a.pipeline) want.set(jobOf(uid, 'pipeline'), { name: jobOf(uid, 'pipeline'), schedule: parseSchedule(a.pipeline), run: pipelineRun(uid), lastRanAt: lastRanAt('pipeline', uid) });
        if (uid === OWNER_ID && inboxChecks && a.inbox?.schedule) want.set('inbox', { name: 'inbox', schedule: parseSchedule(a.inbox.schedule), run: inboxRun, lastRanAt: lastRanAt('inbox') });
      }
      automaticOn.clear();
      for (const { uid } of on) automaticOn.add(uid);
      for (const name of synced) if (!want.has(name)) jobsScheduler.set(name, null);
      for (const [name, job] of want) jobsScheduler.set(name, job);
      synced = new Set(want.keys());
    };
    automationHooks.sync = async () => {
      await sync().catch((err: Error) => log.warn?.(`[schedule] automatic runs: ${err.message}`));
    };
    automationHooks.next = (uid) => ({ pipeline: statusOf(jobOf(uid, 'pipeline'))?.next ?? null, inbox: uid === OWNER_ID ? (statusOf('inbox')?.next ?? null) : null });
    let syncTimer: ReturnType<typeof setInterval> | null = null;
    app.addHook('onReady', async () => {
      await automationHooks.sync();
      await jobsScheduler.start();
      syncTimer = setInterval(() => void automationHooks.sync(), services.automationSyncMs ?? 5 * 60 * 1000); // sync catches its own errors
      syncTimer.unref();
    });
    app.addHook('onClose', async () => {
      jobsScheduler.stop();
      if (syncTimer) clearInterval(syncTimer);
    });
  }

  // The jobs a user may see: the app's (backup, restore test) and their own automatic runs, never another user's.
  app.get('/api/schedule', { schema: { summary: "The app's scheduled jobs and your automatic runs, and when each runs next (empty when none are set)", response: { 200: anyObject } } }, async (req) => {
    const uid = req.uid ?? OWNER_ID;
    const mine = (name: string) => !/^(pipeline|inbox)(:\d+)?$/.test(name) || name === jobOf(uid, 'pipeline') || name === jobOf(uid, 'inbox');
    return { timeZone: timeZone(), jobs: (scheduler?.status() ?? []).filter((j) => mine(j.name)) };
  });

  app.get('/api/tasks', { schema: { summary: 'Recent background tasks, newest first (without output)', response: { 200: { type: 'array', items: anyObject } } } }, async (req) =>
    tasks.list({ uid: req.uid ?? 0 }),
  );

  app.get<{ Params: { id: string }; Querystring: { from?: number } }>(
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

  app.get<{ Params: { id: string } }>(
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
  return (app as App) as BuiltApp;
}
