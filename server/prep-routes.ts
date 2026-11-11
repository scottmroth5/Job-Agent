// Meeting prep routes: start a prep for a job (a background task), read one, delete one. Prep text and the
// people's names stay in the database and the response; task output holds counts only.
import { MAX_ATTENDEES, MEETING_FORMATS, MEETING_KINDS, listPreps, writeMeetingPrep } from '../agents/hunt/prep.ts';
import type { Claude } from '@scottmroth5/agent-core';
import type { JobStore } from '../tools/types.ts';
import type { UserConfig } from '../agents/user-config.ts';
import type { MeetingPrepsRow } from '../db/types.ts';
import type { App, IdParams, RouteServices, StartTask } from './types.ts';

/** What the prep dialog sends (the body schema below); writeMeetingPrep checks and tidies it again. */
type PrepBody = {
  attendees: Array<{ name: string; role?: string; organization?: string; url?: string; about?: string }>;
  meetingAt?: string | null;
  kind?: string | null;
  format?: string | null;
  context?: string | null;
  research?: boolean;
};

const anyObject = { type: 'object', additionalProperties: true };
const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } };
const str = (max: number) => ({ type: 'string', maxLength: max });

/** startTask is the app's task starter (it refuses while a pipeline step runs). */
export function registerPrepRoutes(app: App, { store, config, services, startTask }: { store: JobStore; config: UserConfig; services: RouteServices; startTask: StartTask }) {
  const { db } = store;

  app.post<{ Params: IdParams; Body: PrepBody }>(
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
      if (!services.claude) return reply.code(503).send({ error: 'AI is not available here.' });
      const id = req.params.id;
      if (!await db.prepare('SELECT 1 FROM postings WHERE id = ? AND user_id = @uid').get(id)) return reply.code(404).send({ error: 'Job not found' });
      if (!req.body.attendees.some((a) => a.name?.trim())) return reply.code(400).send({ error: 'Add at least one person the meeting is with.' });
      const taskId = await startTask('meeting-prep', { id }, async (step, { run }) => {
        const r = await writeMeetingPrep({
          store,
          config,
          // services.claude was checked above, before the task started.
          claude: services.claude as Claude,
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

  app.get<{ Params: IdParams }>('/api/postings/:id/meeting-preps', { schema: { summary: "A job's meeting preps, newest first (without their text)", params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } }, response: { 200: { type: 'array', items: anyObject } } } }, async (req) =>
    await listPreps(db, req.params.id),
  );

  app.get<{ Params: { id: string } }>('/api/meeting-preps/:id', { schema: { summary: 'One meeting prep with its text (Markdown) and what was asked', params: uuidParams, response: { 200: anyObject } } }, async (req, reply) => {
    const r = await db.prepare('SELECT * FROM meeting_preps WHERE id = ? AND user_id = @uid').get(req.params.id) as MeetingPrepsRow | undefined;
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

  app.delete<{ Params: { id: string } }>('/api/meeting-preps/:id', { schema: { summary: 'Delete a meeting prep from the app (its Google Doc stays in Drive)', params: uuidParams } }, async (req, reply) => {
    const r = await db.prepare('DELETE FROM meeting_preps WHERE id = ? AND user_id = @uid').run(req.params.id);
    if (!r.changes) return reply.code(404).send({ error: 'Meeting prep not found' });
    return reply.code(204).send();
  });
}
