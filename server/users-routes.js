// Admin > Users (multi-user, phase 2): the accounts, approving and rejecting requests for access, pausing and resuming,
// and how each user's AI is paid for. Admin only (server/app.js refuses anyone else on /api/admin/users*), and never
// registered in the demo. Each decision emails the person about their own account (server/notices.js).
import { decide, DECISION_NAMES, getUser, setAiAccess } from '../db/users.js';
import { listUsers } from './admin-queries.js';

const anyObject = { type: 'object', additionalProperties: true };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

export function registerUserRoutes(app, { db, notices = {} }) {
  app.get('/api/admin/users', { schema: { summary: 'Every account, with its AI setup and this month\'s spend (admin)', response: { 200: { type: 'array', items: anyObject } } } }, async () =>
    listUsers(db),
  );

  app.post(
    '/api/admin/users/:id/:decision',
    {
      schema: {
        summary: 'Approve, reject, pause, or resume an account (admin)',
        params: { type: 'object', required: ['id', 'decision'], properties: { id: { type: 'integer', minimum: 1 }, decision: { type: 'string', enum: DECISION_NAMES } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const user = decide(db, req.params.id, req.params.decision, { by: req.uid });
      // The person hears about their own account (resuming needs no email).
      switch (req.params.decision) {
        case 'approve':
          await notices.approved?.(user);
          break;
        case 'reject':
          await notices.rejected?.(user);
          break;
        case 'pause':
          await notices.paused?.(user);
          break;
        default:
          break;
      }
      return user;
    },
  );

  app.put(
    '/api/admin/users/:id/ai',
    {
      schema: {
        summary: "How a user's AI is paid for: their own key, or the owner's key up to a monthly cap (admin)",
        params: idParams,
        body: {
          type: 'object',
          required: ['source'],
          additionalProperties: false,
          properties: { source: { type: 'string', enum: ['own', 'owner'] }, capUsd: { type: ['number', 'null'] } },
        },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      if (!getUser(db, req.params.id)) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
      return setAiAccess(db, req.params.id, req.body);
    },
  );
}
