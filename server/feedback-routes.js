// Send feedback (multi-user, phase 4): any signed-in user writes to the owner from Settings. It is saved (theirs, in the
// feedback table) and emailed to the owner with the user as reply-to; the owner sees it all on Admin > Users and marks it
// done. A user may send FEEDBACK_PER_DAY a day, so the form can never be used to flood the owner's inbox.
import { randomUUID } from 'node:crypto';
import { getUser, OWNER_ID } from '../db/users.js';
import { listFeedback, markFeedbackDone } from './admin-queries.js';

export const FEEDBACK_PER_DAY = 10;
export const MAX_FEEDBACK_CHARS = 4000;
const anyObject = { type: 'object', additionalProperties: true };

export function registerFeedbackRoutes(app, { db, notices = {}, admin = true }) {
  app.post(
    '/api/feedback',
    {
      schema: {
        summary: 'Send the owner feedback',
        body: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: { body: { type: 'string', maxLength: MAX_FEEDBACK_CHARS }, page: { type: 'string', maxLength: 100 } },
        },
        response: { 201: anyObject },
      },
    },
    async (req, reply) => {
      const body = req.body.body.trim();
      if (!body) throw Object.assign(new Error('Write something first.'), { statusCode: 400 });
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const today = db.prepare('SELECT COUNT(*) FROM feedback WHERE user_id = @uid AND created_at >= ?').pluck().get(since);
      if (today >= FEEDBACK_PER_DAY) throw Object.assign(new Error('That is a lot of feedback for one day. Try again tomorrow.'), { statusCode: 429 });
      const id = randomUUID();
      const page = req.body.page?.replace(/[^\w#/ -]/g, '').slice(0, 100) || null;
      db.prepare('INSERT INTO feedback (user_id, id, body, page, created_at) VALUES (@uid, ?, ?, ?, ?)').run(id, body, page, new Date().toISOString());
      // The owner's own feedback is a note to self: saved, not emailed.
      if ((req.uid ?? OWNER_ID) !== OWNER_ID) await notices.feedback?.(getUser(db, req.uid), body, page);
      return reply.code(201).send({ id, sent: true });
    },
  );

  if (!admin) return;
  app.get('/api/admin/feedback', { schema: { summary: 'Feedback from every user, open first (admin)', response: { 200: { type: 'array', items: anyObject } } } }, async () =>
    listFeedback(db),
  );
  app.post(
    '/api/admin/feedback/:id/done',
    { schema: { summary: 'Mark feedback done (admin)', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } }, response: { 200: anyObject } } },
    async (req) => {
      if (!markFeedbackDone(db, req.params.id)) throw Object.assign(new Error('No open feedback with that id.'), { statusCode: 404 });
      return { done: true };
    },
  );
}
