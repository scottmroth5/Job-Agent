// Meeting prep routes: start a prep for a job (a background task), read one, delete one. Prep text and the
// people's names stay in the database and the response; task output holds counts only.
import { MAX_ATTENDEES, MEETING_FORMATS, MEETING_KINDS, listPreps, writeMeetingPrep } from '../agents/hunt/prep.js';

const anyObject = { type: 'object', additionalProperties: true };
const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } };
const str = (max) => ({ type: 'string', maxLength: max });

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} deps
 * @param {Function} deps.startTask  the app's task starter (refuses while a pipeline step runs)
 */
export function registerPrepRoutes(app, { store, config, services, startTask }) {
  const { db } = store;

  app.post(
    '/api/postings/:id/meeting-prep',
    {
      schema: {
        summary: 'Write meeting prep for a job: who the meeting is with, optional time, kind, format, and context. Runs as a task.',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } },
        body: {
          type: 'object',
          required: ['attendees'],
          additionalProperties: false,
          properties: {
            attendees: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_ATTENDEES,
              items: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: { name: str(120), role: str(160), organization: str(160), url: str(500), about: str(1500) },
              },
            },
            meetingAt: { type: ['string', 'null'], maxLength: 40 },
            kind: { type: ['string', 'null'], enum: [...MEETING_KINDS, null] },
            format: { type: ['string', 'null'], enum: [...MEETING_FORMATS, null] },
            context: { type: ['string', 'null'], maxLength: 6000 },
            research: { type: 'boolean' },
          },
        },
        response: { 202: { type: 'object', properties: { taskId: { type: 'string' } } } },
      },
    },
    async (req, reply) => {
      const id = req.params.id;
      if (!db.prepare('SELECT 1 FROM postings WHERE id = ?').get(id)) return reply.code(404).send({ error: 'Job not found' });
      if (!req.body.attendees.some((a) => a.name?.trim())) return reply.code(400).send({ error: 'Add at least one person the meeting is with.' });
      const taskId = startTask('meeting-prep', { id }, async (step, { run }) => {
        const r = await writeMeetingPrep({
          store,
          config,
          claude: services.claude,
          knowledge: await services.knowledge(),
          drive: services.drive,
          run,
          postingId: id,
          input: req.body,
          onStep: step,
        });
        step(r.docUrl ? 'Prep ready and saved as a Google Doc' : r.docError ? 'Prep ready (the Google Doc could not be made)' : 'Prep ready');
        return { prepId: r.id, docUrl: r.docUrl, costUsd: r.costUsd, webSearches: r.webSearches };
      });
      return reply.code(202).send({ taskId });
    },
  );

  app.get('/api/postings/:id/meeting-preps', { schema: { summary: "A job's meeting preps, newest first (without their text)", params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } }, response: { 200: { type: 'array', items: anyObject } } } }, async (req) =>
    listPreps(db, req.params.id),
  );

  app.get('/api/meeting-preps/:id', { schema: { summary: 'One meeting prep with its text (Markdown) and what was asked', params: uuidParams, response: { 200: anyObject } } }, async (req, reply) => {
    const r = db.prepare('SELECT * FROM meeting_preps WHERE id = ?').get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'Meeting prep not found' });
    return {
      id: r.id,
      postingId: r.posting_id,
      attendees: JSON.parse(r.attendees_json),
      meetingAt: r.meeting_at,
      kind: r.meeting_kind,
      format: r.meeting_format,
      context: r.context,
      research: Boolean(r.research),
      content: r.content,
      docUrl: r.doc_url,
      docName: r.doc_name,
      model: r.model,
      costUsd: r.cost_usd,
      webSearches: r.web_searches,
      createdAt: r.created_at,
    };
  });

  app.delete('/api/meeting-preps/:id', { schema: { summary: 'Delete a meeting prep from the app (its Google Doc stays in Drive)', params: uuidParams } }, async (req, reply) => {
    const r = db.prepare('DELETE FROM meeting_preps WHERE id = ?').run(req.params.id);
    if (!r.changes) return reply.code(404).send({ error: 'Meeting prep not found' });
    return reply.code(204).send();
  });
}
