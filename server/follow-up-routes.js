// Follow-ups (agents/follow-ups.js): the user's stale-application days (Settings > Follow-ups), closing applications
// with no reply as no response (one job, or every stale one from Home), and Find someone to contact for one job (a
// task on the user's AI, saved as a note on the job; agents/hunt/find-contact.js).
import { OWNER_ID } from '../db/users.js';
import { closeNoResponse, setStaleDays, staleDays, waitingApplications, DEFAULT_STALE_DAYS, FOLLOW_UP_FROM, MAX_STALE_DAYS, MIN_STALE_DAYS } from '../agents/follow-ups.js';
import { findContact } from '../agents/hunt/find-contact.js';
import { demoContactResult } from '../demo/sample-data.js';

export const CONTACT_SEARCHES_PER_DAY = 20;
const anyObject = { type: 'object', additionalProperties: true };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

export function registerFollowUpRoutes(app, { store, config, services, startTask, demo = false }) {
  const { db } = store;

  // The demo's Find someone to contact: a canned sample answer for the job, as a read. It calls no model, so the demo
  // never spends anything, and saves nothing. Registered only in the demo.
  if (demo) {
    app.get('/api/postings/:id/find-contact/sample', { schema: { summary: 'Demo only: a sample Find someone to contact answer for this job (no AI, nothing saved)', params: idParams, response: { 200: anyObject } } }, async (req, reply) => {
      const p = db.prepare('SELECT company, title, applied_on FROM postings WHERE id = ? AND user_id = @uid').get(req.params.id);
      if (!p) return reply.code(404).send({ error: 'Job not found' });
      return { sample: true, markdown: demoContactResult({ company: p.company, title: p.title, appliedOn: p.applied_on }) };
    });
  }
  const searches = new Map(); // uid -> timestamps in the last day
  const settings = () => ({ staleDays: staleDays(db), defaultStaleDays: DEFAULT_STALE_DAYS, followUpFrom: FOLLOW_UP_FROM, min: MIN_STALE_DAYS, max: MAX_STALE_DAYS });

  app.get('/api/follow-ups', { schema: { summary: 'Your follow-up settings and how many applications are waiting: worth a follow-up, and stale', response: { 200: anyObject } } }, async () => {
    const w = waitingApplications(db);
    return { ...settings(), followUp: w.followUp.length, stale: w.stale.length };
  });

  app.put(
    '/api/follow-ups/settings',
    { schema: { summary: 'Set the days with no reply after which an application is stale', body: { type: 'object', required: ['staleDays'], additionalProperties: false, properties: { staleDays: { type: 'integer' } } }, response: { 200: anyObject } } },
    async (req) => {
      setStaleDays(db, req.body.staleDays);
      return settings();
    },
  );

  app.get('/api/follow-ups/stale', { schema: { summary: 'Your stale applications (no reply after your stale days), oldest first; nothing changes', response: { 200: anyObject } } }, async () => ({
    staleDays: staleDays(db),
    jobs: closeNoResponse(db, { dryRun: true }),
  }));

  app.post('/api/follow-ups/close-stale', { schema: { summary: 'Close every stale application (no reply after your stale days) as no response', response: { 200: anyObject } } }, async () => {
    const jobs = closeNoResponse(db);
    return { closed: jobs.length, jobs };
  });

  app.post('/api/postings/:id/close-no-response', { schema: { summary: 'Close one application with no reply as no response', params: idParams, response: { 200: anyObject } } }, async (req, reply) => {
    if (!db.prepare('SELECT 1 FROM postings WHERE id = ? AND user_id = @uid').get(req.params.id)) return reply.code(404).send({ error: 'Job not found' });
    const jobs = closeNoResponse(db, { ids: [req.params.id] });
    if (!jobs.length) return reply.code(409).send({ error: 'This job is not an application waiting for a reply.' });
    return { closed: 1, jobs };
  });

  app.post(
    '/api/postings/:id/find-contact',
    { schema: { summary: 'Find the likely hiring manager or a recruiter for this job and draft a short note (web search on your AI; saved as a note). Runs as a task.', params: idParams, response: { 202: { type: 'object', properties: { taskId: { type: 'string' } } } } } },
    async (req, reply) => {
      if (!services.claude) return reply.code(503).send({ error: 'AI is not available here.' });
      const id = req.params.id;
      if (!db.prepare('SELECT 1 FROM postings WHERE id = ? AND user_id = @uid').get(id)) return reply.code(404).send({ error: 'Job not found' });
      const uid = req.uid ?? OWNER_ID;
      const day = Date.now() - 24 * 3600 * 1000;
      const recent = (searches.get(uid) ?? []).filter((t) => t > day);
      if (recent.length >= CONTACT_SEARCHES_PER_DAY) return reply.code(429).send({ error: 'That is a lot of searches for one day. Try again tomorrow.' });
      searches.set(uid, [...recent, Date.now()]);
      const knowledge = await services.knowledge();
      const taskId = startTask('find-contact', { id }, async (step, { run }) => {
        const r = await findContact({ store, config, claude: services.claude, knowledge, run, postingId: id, onStep: step });
        step('Saved as a note on the job');
        return r;
      });
      return reply.code(202).send({ taskId });
    },
  );
}
