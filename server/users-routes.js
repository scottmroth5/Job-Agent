// Admin > Users (multi-user, phase 2): the accounts, approving and rejecting requests for access, pausing and resuming,
// and how each user's AI is paid for. Admin only (server/app.js refuses anyone else on /api/admin/users*), and never
// registered in the demo. Each decision emails the person about their own account (server/notices.js).
import { decide, DECISION_NAMES, getUser, setAiAccess } from '../db/users.js';
import { listUsers } from './admin-queries.js';
import { deleteAccount } from '../agents/account-data.js';
import { ATTACHMENTS_DIR } from './attachments.js';

const anyObject = { type: 'object', additionalProperties: true };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

export function registerUserRoutes(app, { db, notices = {}, attachmentsDir = ATTACHMENTS_DIR }) {
  // Deleting someone's account removes everything that is theirs; their address must be typed to confirm.
  app.post(
    '/api/admin/users/:id/delete',
    {
      schema: {
        summary: "Delete a user's account and everything in it (admin; type their address to confirm)",
        params: idParams,
        body: { type: 'object', required: ['confirmEmail'], additionalProperties: false, properties: { confirmEmail: { type: 'string' } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const user = getUser(db, req.params.id);
      if (!user) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
      if (req.body.confirmEmail.trim().toLowerCase() !== user.email) throw Object.assign(new Error(`Type ${user.email} to confirm.`), { statusCode: 400 });
      const counts = deleteAccount(db, user.id, { attachmentsDir });
      await notices.accountDeleted?.(user, { byOwner: true });
      return { deleted: true, jobs: counts.postings ?? 0 };
    },
  );

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
          properties: { source: { type: 'string', enum: ['own', 'owner'] }, capUsd: { type: ['number', 'null'] }, confirmEmail: { type: 'string' } },
        },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const before = getUser(db, req.params.id);
      if (!before) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
      // Putting someone on the owner's key spends the owner's money: their address must be typed to confirm who.
      const granting = req.body.source === 'owner' && before.ai_source !== 'owner';
      if (granting && String(req.body.confirmEmail ?? '').trim().toLowerCase() !== before.email) {
        throw Object.assign(new Error(`Type ${before.email} to confirm you want to pay for their AI.`), { statusCode: 400 });
      }
      const after = setAiAccess(db, req.params.id, req.body);
      // They hear when the owner starts or stops covering them, or changes the cap.
      if (after.ai_source === 'owner' && (granting || after.ai_cap_usd !== before.ai_cap_usd)) await notices.aiCovered?.(after, after.ai_cap_usd);
      if (after.ai_source === 'own' && before.ai_source === 'owner') await notices.aiOwnKey?.(after);
      return after;
    },
  );
}
