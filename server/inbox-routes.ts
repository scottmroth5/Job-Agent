// Inbox screen: check Gmail, resolve emails that need review, and close reminders. Email subjects and
// summaries are shown to the user here (local server only); they are never logged.
import { OWNER_ID } from '../db/users.ts';
import { listNeedsReview, resolveReview, CHOICES } from '../agents/inbox/review.ts';
import { listOpenApplications } from '../agents/inbox/match.ts';
import { trimBody } from '../agents/inbox/atsParse.ts';
import type { Db, JobStore } from '../tools/types.ts';
import type { Gmail } from '../agents/inbox/gmail.ts';
import type { InboxConfig } from '../agents/inbox/config.ts';
import type { App } from './types.ts';
import type { Jobs } from './jobs.ts';
import type { StartCheck } from './tasks/inbox.ts';

/** The inbox's services (server/main.ts): whether Gmail is signed in, its client, the email key, and inbox.json. */
export interface InboxServices {
  ready: () => boolean;
  gmail: (opts?: { onWait?: (ms: number) => void }) => Gmail;
  key: () => Buffer;
  cfg: InboxConfig;
}

const anyObject = { type: 'object', additionalProperties: true };
const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } };

/** Everything the Inbox screen shows. */
export async function inboxOverview(db: Db, { ready }: { ready: boolean }) {
  return {
    signedIn: ready,
    lastCheck: await db.prepare("SELECT status, started_at AS \"startedAt\", finished_at AS \"finishedAt\" FROM runs WHERE name IN ('inbox', 'inbox-backfill') ORDER BY id DESC LIMIT 1").get() ?? null,
    needsReview: (await listNeedsReview(db)).map((e) => ({
      id: e.id,
      sentAt: e.sent_at,
      sender: e.sender,
      subject: e.subject,
      type: e.type,
      confidence: e.confidence,
      summary: e.summary,
      reason: e.review_reason,
      extracted: e.extracted,
      guess: e.guess,
    })),
    reminders: await db
      .prepare(`SELECT r.id, r.kind, r.due_at AS "dueAt", r.note, r.created_at AS "createdAt", p.id AS "postingId", p.company, p.title
        FROM reminders r JOIN postings p ON p.id = r.posting_id AND p.user_id = r.user_id WHERE r.user_id = @uid AND r.status = 'open' ORDER BY COALESCE(r.due_at, r.created_at)`)
      .all(),
    recent: await db
      .prepare(`SELECT e.id, e.sent_at AS "sentAt", e.sender, e.subject, e.type, e.match_rule AS "matchRule", e.review_status AS "reviewStatus",
          e.summary, p.id AS "postingId", p.company, p.title, p.status
        FROM emails e JOIN postings p ON p.id = e.posting_id AND p.user_id = e.user_id
        WHERE e.user_id = @uid AND e.review_status IN ('auto', 'confirmed', 'reassigned', 'new_opportunity') ORDER BY e.sent_at DESC LIMIT 40`)
      .all(),
    openApplications: (await listOpenApplications(db)).map(({ id, company, title, status }) => ({ id, company, title, status })),
  };
}

/** The check itself is a task (server/tasks/inbox.ts); startCheck starts one (inboxStarter). */
export function registerInboxRoutes(app: App, { store, jobs, inbox, startCheck }: { store: JobStore; jobs: Jobs; inbox: InboxServices; startCheck: StartCheck }) {
  const { db } = store;

  app.get('/api/inbox', { schema: { summary: 'Emails to review, open reminders, recent linked emails, last check', response: { 200: anyObject } } }, async (req) => {
    const task = await jobs.queue.active(req.uid ?? OWNER_ID, 'inbox');
    return { ...await inboxOverview(db, { ready: inbox.ready() }), checkTaskId: task?.id ?? null };
  });

  app.post(
    '/api/inbox/check',
    { schema: { summary: 'Check Gmail for new job email now', response: { 202: { type: 'object', properties: { taskId: { type: 'string' } } } } } },
    async (req, reply) => reply.code(202).send({ taskId: await startCheck() }),
  );

  app.post<{ Params: { id: string }; Body: { choice: string; postingId?: number } }>(
    '/api/inbox/emails/:id/review',
    {
      schema: {
        summary: 'Resolve an email that needs review: confirm the guess, reassign, not job related, new opportunity, or dismiss',
        params: uuidParams,
        body: { type: 'object', required: ['choice'], additionalProperties: false, properties: { choice: { type: 'string', enum: CHOICES }, postingId: { type: 'integer', minimum: 1 } } },
        response: { 200: anyObject },
      },
    },
    async (req, reply) => {
      const e = (await listNeedsReview(db)).find((x) => x.id === req.params.id);
      if (!e) return reply.code(404).send({ error: 'That email is not waiting for review.' });
      const { choice, postingId } = req.body;
      if (choice === 'reassign' && !postingId) return reply.code(400).send({ error: 'Choose the job to link it to.' });
      // The body is re-read from Gmail so a newly linked email keeps it (encrypted), as the inbox run would.
      let body: string | null = null;
      if (inbox.ready() && choice !== 'not_job' && choice !== 'dismiss') {
        const m = await inbox.gmail({ onWait: () => {} }).getMessage(e.gmail_message_id).catch(() => null);
        body = m ? trimBody(m.rawBody, { html: m.bodyIsHtml, max: inbox.cfg.bodyChars }) : null;
      }
      try {
        const r = await resolveReview(db, e, choice, { postingId, body, key: body ? inbox.key() : null });
        return { postingId: r.postingId, statusChange: r.statusChange, review: r.review, notices: r.notices.filter((n) => !n.startsWith('Needs review')) };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

}

/** Closing a reminder: registered whether or not Gmail is set up, since the job panel's Next step box closes them too. */
export function registerReminderRoutes(app: App, { db }: { db: Db }) {
  app.patch<{ Params: { id: string }; Body: { status: 'done' | 'dismissed' } }>(
    '/api/inbox/reminders/:id',
    {
      schema: {
        summary: 'Mark a reminder done or dismissed',
        params: uuidParams,
        body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['done', 'dismissed'] } } },
        response: { 200: anyObject },
      },
    },
    async (req, reply) => {
      const r = await db.prepare("UPDATE reminders SET status = ? WHERE id = ? AND user_id = @uid AND status = 'open'").run(req.body.status, req.params.id);
      if (!r.changes) return reply.code(404).send({ error: 'Reminder not found or already closed.' });
      return { id: req.params.id, status: req.body.status };
    },
  );
}


