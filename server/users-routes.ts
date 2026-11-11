// Admin > Users (multi-user, phase 2): the accounts, approving and rejecting requests for access, pausing and resuming,
// and how each user's AI is paid for. Admin only (server/app.ts refuses anyone else on /api/admin/users*), and never
// registered in the demo. Each decision emails the person about their own account (server/notices.ts).
import { decide, DECISION_NAMES, getUser, setAiAccess } from '../db/users.ts';
import { listUsers, usageByWeek, usagePeriodStart, usageTotals } from './admin-queries.ts';
import { BROWSER_NAMES, DEVICES, SOURCES } from './usage-totals.ts';
import { deleteAccount } from '../agents/account-data.ts';
import { ATTACHMENTS_DIR } from './attachments.ts';
import type { Db } from '../tools/types.ts';
import type { User } from '../db/users.ts';
import type { App, IdParams, Notices } from './types.ts';

const anyObject = { type: 'object', additionalProperties: true };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

export function registerUserRoutes(app: App, { db, notices = {}, attachmentsDir = ATTACHMENTS_DIR }: { db: Db; notices?: Notices; attachmentsDir?: string }) {
  // Deleting someone's account removes everything that is theirs; their address must be typed to confirm.
  app.post<{ Params: IdParams; Body: { confirmEmail: string } }>(
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
      const user = await getUser(db, req.params.id);
      if (!user) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
      if (req.body.confirmEmail.trim().toLowerCase() !== user.email) throw Object.assign(new Error(`Type ${user.email} to confirm.`), { statusCode: 400 });
      const counts = await deleteAccount(db, user.id, { attachmentsDir });
      await notices.accountDeleted?.(user, { byOwner: true });
      return { deleted: true, jobs: counts.postings ?? 0 };
    },
  );

  // The app's weekly totals (counts only; no names, jobs, or text). Private: nothing goes to an analytics service.
  const counts = ['accountsSeen', 'pipelineCompleted', 'pipelineFailed', 'jobsAdded', 'lettersWritten', 'prepsWritten', 'feedbackReceived'];
  const weekRow = {
    type: 'object',
    additionalProperties: false,
    required: ['weekEnding', ...counts, 'claudeSpendUsd'],
    properties: {
      weekEnding: { type: 'string', description: 'The Saturday the week ends (YYYY-MM-DD, app time zone)' },
      ...Object.fromEntries(counts.map((k) => [k, { type: 'integer' }])),
      claudeSpendUsd: { type: 'number' },
    },
  };
  // Device, browser, location, and source totals over the same weeks (server/usage-totals.ts): app-wide, never per account.
  const total = (values: string[] | null, pattern?: string) => ({
    type: 'object',
    additionalProperties: false,
    required: ['value', 'count'],
    properties: { value: values ? { type: 'string', enum: values } : { type: 'string', pattern }, count: { type: 'integer' } },
  });
  const place = {
    type: 'object',
    additionalProperties: false,
    required: ['city', 'state', 'country', 'count'],
    properties: { city: { type: 'string' }, state: { type: 'string' }, country: { type: 'string' }, count: { type: 'integer' } },
  };
  app.get<{ Querystring: { weeks: number } }>(
    '/api/admin/usage',
    {
      schema: {
        summary: 'Weekly totals across all accounts (Sunday to Saturday, newest first), plus visits by device, browser, and location and arrivals by source (admin)',
        querystring: { type: 'object', additionalProperties: false, properties: { weeks: { type: 'integer', minimum: 4, maximum: 52, default: 12 } } },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['weeks', 'devices', 'browsers', 'locations', 'sources'],
            properties: {
              weeks: { type: 'array', items: weekRow },
              devices: { type: 'array', items: total(DEVICES) },
              browsers: { type: 'array', items: total(null, `^(?:(?:${BROWSER_NAMES.join('|')}) \\d{1,3}|Other)$`) },
              locations: { type: 'array', items: place },
              sources: { type: 'array', items: total(SOURCES) },
            },
          },
        },
      },
    },
    async (req) => ({ weeks: await usageByWeek(db, { weeks: req.query.weeks }), ...await usageTotals(db, { since: usagePeriodStart(req.query.weeks) }) }),
  );

  app.get('/api/admin/users', { schema: { summary: 'Every account, with its AI setup and this month\'s spend (admin)', response: { 200: { type: 'array', items: anyObject } } } }, async () =>
    await listUsers(db),
  );

  app.post<{ Params: { id: number; decision: string } }>(
    '/api/admin/users/:id/:decision',
    {
      schema: {
        summary: 'Approve, reject, pause, or resume an account (admin)',
        params: { type: 'object', required: ['id', 'decision'], properties: { id: { type: 'integer', minimum: 1 }, decision: { type: 'string', enum: DECISION_NAMES } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      // Admin routes always run as a signed-in admin, so uid is set.
      // decide throws unless the user exists, so it returns their row.
      const user = (await decide(db, req.params.id, req.params.decision, { by: req.uid as number })) as User;
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

  app.put<{ Params: IdParams; Body: { source: 'own' | 'owner'; capUsd?: number | null; confirmEmail?: string } }>(
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
      const before = await getUser(db, req.params.id);
      if (!before) throw Object.assign(new Error('User not found.'), { statusCode: 404 });
      // Putting someone on the owner's key spends the owner's money: their address must be typed to confirm who.
      const granting = req.body.source === 'owner' && before.ai_source !== 'owner';
      if (granting && String(req.body.confirmEmail ?? '').trim().toLowerCase() !== before.email) {
        throw Object.assign(new Error(`Type ${before.email} to confirm you want to pay for their AI.`), { statusCode: 400 });
      }
      const after = (await setAiAccess(db, req.params.id, req.body)) as NonNullable<Awaited<ReturnType<typeof setAiAccess>>>; // the user was found above
      // They hear when the owner starts or stops covering them, or changes the cap.
      if (after.ai_source === 'owner' && (granting || after.ai_cap_usd !== before.ai_cap_usd)) await notices.aiCovered?.(after, after.ai_cap_usd);
      if (after.ai_source === 'own' && before.ai_source === 'owner') await notices.aiOwnKey?.(after);
      return after;
    },
  );
}
