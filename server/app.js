// The Job Hunt API. Every route has a JSON schema; the OpenAPI spec at /api/openapi.json is the
// contract the UI (and any future backend rewrite) follows.
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import { createTracer } from '@scottmroth5/agent-core';
import { listPostings, getPosting, updatePosting, summary } from './queries.js';
import { registerLookupRoutes } from './lookups-routes.js';
import { lookups } from '../agents/lookups.js';
import { funnel } from './funnel.js';
import { createTaskRunner } from './tasks.js';
import { registerAuth } from './auth.js';
import { registerAdminRoutes } from './admin.js';
import { registerPipelineRoutes } from './pipeline-routes.js';
import { registerInboxRoutes } from './inbox-routes.js';
import { addPosting } from '../agents/manual.js';
import { scorePostings, DEFAULT_SCORE_MODEL } from '../agents/discovery/score.js';
import { generateForPostings } from '../agents/hunt/generate.js';
import { resolveDetails } from '../agents/discovery/details.js';
import { jobIdFromUrl } from '../agents/discovery/sources/linkedin.js';
import * as fractionaljobs from '../agents/discovery/sources/fractionaljobs.js';
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
export async function buildApp({ store, config, services, webDir, authMode = 'none', auth = {}, logger = false }) {
  const app = Fastify({ logger });
  const { db } = store;
  const tasks = createTaskRunner();

  await app.register(swagger, {
    openapi: { info: { title: 'Job Agent API', version: '1.0.0', description: 'Job Hunt UI backend' } },
  });
  registerAuth(app, { mode: authMode, settings: auth.settings, exchange: auth.exchange, now: auth.now });
  app.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true }));

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode ?? (err.validation ? 400 : 500);
    reply.code(status).send({ error: err.message });
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
      const run = createTracer({ store, logger }).startRun(`ui-${kind}`, meta);
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

  app.get('/api/summary', { schema: { summary: 'Counts, fractional target, and spend', response: { 200: anyObject } } }, async () => summary(db, config));

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
    return getPosting(db, req.params.id, config) ?? notFound(reply);
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
      const posting = db.prepare('SELECT * FROM postings WHERE id = ?').get(id);
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
          if (posting.stage === 'discovered') db.prepare("UPDATE postings SET stage = 'pipeline', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
          const hasScore = db.prepare("SELECT 1 FROM scores WHERE posting_id = ? AND source IN ('v2', 'v2-rule')").get(id);
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
        if (/fractionaljobs\.io\/jobs\//i.test(posting.url ?? '')) item.fetchDetails = (h) => fractionaljobs.fetchPosting(h, posting.url);
        await resolveDetails(item, { http: services.http, browser });
        const ok = item.fetchStatus === 'ok';
        db.prepare(`UPDATE postings SET fetched_text = COALESCE(@text, fetched_text), fetched_at = CASE WHEN @text IS NULL THEN fetched_at ELSE @now END,
            fetch_status = @status, fetch_method = @method, fetch_attempts = fetch_attempts + 1, location = COALESCE(location, @location),
            location_check = @check, updated_at = @now WHERE id = @id`).run({
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
  registerLookupRoutes(app, { db });
  if (services.runPipeline) registerPipelineRoutes(app, { db, tasks, runPipeline: services.runPipeline });
  if (services.inbox) registerInboxRoutes(app, { store, tasks, claude: services.claude, inbox: services.inbox });

  app.get('/api/tasks', { schema: { summary: 'Recent background tasks, newest first (without output)', response: { 200: { type: 'array', items: anyObject } } } }, async () =>
    tasks.list(),
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
    async (req, reply) => tasks.log(req.params.id, req.query.from ?? 0) ?? reply.code(404).send({ error: 'Task not found' }),
  );

  app.get(
    '/api/tasks/:id',
    { schema: { summary: 'Progress of a background action', params: { type: 'object', properties: { id: { type: 'string' } } }, response: { 200: anyObject } } },
    async (req, reply) => tasks.get(req.params.id) ?? reply.code(404).send({ error: 'Task not found' }),
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
