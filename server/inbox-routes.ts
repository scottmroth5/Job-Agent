// Inbox screen: check Gmail, resolve emails that need review, and close reminders. Email subjects and
// summaries are shown to the user here (local server only); they are never logged.
import { asEngine } from '../db/engine/index.ts';
import { createJobTracer } from '../tools/trace.ts';
import { assertNoRunningRun, oneStartAtATime } from '../tools/runs.ts';
import { runInbox } from '../agents/inbox/process.ts';
import { listNeedsReview, resolveReview, CHOICES } from '../agents/inbox/review.ts';
import { listOpenApplications } from '../agents/inbox/match.ts';
import { trimBody } from '../agents/inbox/atsParse.ts';
import type { Claude } from '@scottmroth5/agent-core';
import type { Database, JobStore, Logger } from '../tools/types.ts';
import type { Gmail } from '../agents/inbox/gmail.ts';
import type { InboxConfig } from '../agents/inbox/config.ts';
import type { App, TaskStep, Tasks } from './types.ts';

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
export async function inboxOverview(db: Database, { ready }: { ready: boolean }) {
  return {
    signedIn: ready,
    lastCheck: await asEngine(db).prepare("SELECT status, started_at AS startedAt, finished_at AS finishedAt FROM runs WHERE name IN ('inbox', 'inbox-backfill') ORDER BY id DESC LIMIT 1").get() ?? null,
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
    reminders: await asEngine(db)
      .prepare(`SELECT r.id, r.kind, r.due_at AS dueAt, r.note, r.created_at AS createdAt, p.id AS postingId, p.company, p.title
        FROM reminders r JOIN postings p ON p.id = r.posting_id AND p.user_id = r.user_id WHERE r.user_id = @uid AND r.status = 'open' ORDER BY COALESCE(r.due_at, r.created_at)`)
      .all(),
    recent: await asEngine(db)
      .prepare(`SELECT e.id, e.sent_at AS sentAt, e.sender, e.subject, e.type, e.match_rule AS matchRule, e.review_status AS reviewStatus,
          e.summary, p.id AS postingId, p.company, p.title, p.status
        FROM emails e JOIN postings p ON p.id = e.posting_id AND p.user_id = e.user_id
        WHERE e.user_id = @uid AND e.review_status IN ('auto', 'confirmed', 'reassigned', 'new_opportunity') ORDER BY e.sent_at DESC LIMIT 40`)
      .all(),
    openApplications: (await listOpenApplications(db)).map(({ id, company, title, status }) => ({ id, company, title, status })),
  };
}

export function registerInboxRoutes(app: App, { store, tasks, claude, inbox }: { store: JobStore; tasks: Tasks; claude: Claude | null; inbox: InboxServices }) {
  const { db } = store;
  let checkTaskId: string | null = null;

  app.get('/api/inbox', { schema: { summary: 'Emails to review, open reminders, recent linked emails, last check', response: { 200: anyObject } } }, async () => {
    const task = checkTaskId ? tasks.get(checkTaskId) : null;
    return { ...await inboxOverview(db, { ready: inbox.ready() }), checkTaskId: task?.status === 'running' ? checkTaskId : null };
  });

  app.post(
    '/api/inbox/check',
    { schema: { summary: 'Check Gmail for new job email now', response: { 202: { type: 'object', properties: { taskId: { type: 'string' } } } } } },
    async (req, reply) => reply.code(202).send({ taskId: await startCheck() }),
  );

  /**
   * Starts an inbox check as a task (the Inbox screen and the scheduler). One start at a time (tools/runs.ts): a check
   * started while another is starting sees its task here, before its runs row is written.
   */
  function startCheck({ by = 'button' }: { by?: string } = {}) {
    return oneStartAtATime(async () => {
      if (!inbox.ready()) throw Object.assign(new Error('Gmail is not signed in. Run "npm run inbox:auth" first.'), { statusCode: 400 });
      for (const name of ['inbox', 'inbox-backfill', 'pipeline']) {
        try {
          await assertNoRunningRun(db, name);
        } catch (err) {
          throw Object.assign(new Error(`${(err as Error).message} Try again when it finishes.`), { statusCode: 409 });
        }
      }
      if (checkTaskId && tasks.get(checkTaskId)?.status === 'running') throw Object.assign(new Error('An inbox check is already running. Try again when it finishes.'), { statusCode: 409 });
      checkTaskId = tasks.start('inbox', { by }, async (step: TaskStep, { logger }: { logger: Logger }) => {
        const gmail = inbox.gmail({ onWait: (ms) => logger.warn(`Gmail rate limit reached; waiting ${ms / 1000} seconds, then continuing.`) });
        // A tracer per task, so the run's log lines also go to the task's output (the Activity tab).
        const run = await createJobTracer({ store, logger }).startRun('inbox', { model: inbox.cfg.model });
        try {
          step('Reading new mail');
          // claude is set wherever Gmail can be ready (the demo has neither, and ready() refused above).
          const s = await runInbox({ store, gmail, claude: claude as Claude, cfg: inbox.cfg, key: inbox.key(), run, log: run.log });
          for (const n of s.notices) logger.info(n);
          await run.finish(s.failures.length ? 'partial' : 'ok', { ...s, notices: s.notices.length });
          step(`Done: ${s.considered} job emails, ${s.matched} linked, ${s.needsReview} to review`);
          return { considered: s.considered, matched: s.matched, needsReview: s.needsReview, opportunities: s.opportunities, statusChanges: s.statusChanges.length, notices: s.notices, failures: s.failures.length };
        } catch (err) {
          await run.finish('failed', { error: (err as Error).message });
          throw err;
        }
      });
      return checkTaskId;
    });
  }

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

  return { startCheck };
}

/** Closing a reminder: registered whether or not Gmail is set up, since the job panel's Next step box closes them too. */
export function registerReminderRoutes(app: App, { db }: { db: Database }) {
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
      const r = await asEngine(db).prepare("UPDATE reminders SET status = ? WHERE id = ? AND user_id = @uid AND status = 'open'").run(req.body.status, req.params.id);
      if (!r.changes) return reply.code(404).send({ error: 'Reminder not found or already closed.' });
      return { id: req.params.id, status: req.body.status };
    },
  );
}


