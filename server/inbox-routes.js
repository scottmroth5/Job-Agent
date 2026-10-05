// Inbox screen: check Gmail, resolve emails that need review, and close reminders. Email subjects and
// summaries are shown to the user here (local server only); they are never logged.
import { createTracer } from '@scottmroth5/agent-core';
import { assertNoRunningRun } from '../tools/runs.js';
import { runInbox } from '../agents/inbox/process.js';
import { listNeedsReview, resolveReview, CHOICES } from '../agents/inbox/review.js';
import { listOpenApplications } from '../agents/inbox/match.js';
import { trimBody } from '../agents/inbox/atsParse.js';

const anyObject = { type: 'object', additionalProperties: true };
const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } };

/** Everything the Inbox screen shows. */
export function inboxOverview(db, { ready }) {
  return {
    signedIn: ready,
    lastCheck: db.prepare("SELECT status, started_at AS startedAt, finished_at AS finishedAt FROM runs WHERE name IN ('inbox', 'inbox-backfill') ORDER BY id DESC LIMIT 1").get() ?? null,
    needsReview: listNeedsReview(db).map((e) => ({
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
    reminders: db
      .prepare(`SELECT r.id, r.kind, r.due_at AS dueAt, r.note, r.created_at AS createdAt, p.id AS postingId, p.company, p.title
        FROM reminders r JOIN postings p ON p.id = r.posting_id WHERE r.status = 'open' ORDER BY COALESCE(r.due_at, r.created_at)`)
      .all(),
    recent: db
      .prepare(`SELECT e.id, e.sent_at AS sentAt, e.sender, e.subject, e.type, e.match_rule AS matchRule, e.review_status AS reviewStatus,
          e.summary, p.id AS postingId, p.company, p.title, p.status
        FROM emails e JOIN postings p ON p.id = e.posting_id
        WHERE e.review_status IN ('auto', 'confirmed', 'reassigned', 'new_opportunity') ORDER BY e.sent_at DESC LIMIT 40`)
      .all(),
    openApplications: listOpenApplications(db).map(({ id, company, title, status }) => ({ id, company, title, status })),
  };
}

/**
 * @param {object} ctx
 * @param {{ ready: () => boolean, gmail: () => object, key: () => Buffer, cfg: object }} ctx.inbox
 */
export function registerInboxRoutes(app, { store, tasks, claude, inbox }) {
  const { db } = store;
  let checkTaskId = null;

  app.get('/api/inbox', { schema: { summary: 'Emails to review, open reminders, recent linked emails, last check', response: { 200: anyObject } } }, async () => {
    const task = checkTaskId ? tasks.get(checkTaskId) : null;
    return { ...inboxOverview(db, { ready: inbox.ready() }), checkTaskId: task?.status === 'running' ? checkTaskId : null };
  });

  app.post(
    '/api/inbox/check',
    { schema: { summary: 'Check Gmail for new job email now', response: { 202: { type: 'object', properties: { taskId: { type: 'string' } } } } } },
    async (req, reply) => {
      if (!inbox.ready()) throw Object.assign(new Error('Gmail is not signed in. Run "npm run inbox:auth" first.'), { statusCode: 400 });
      for (const name of ['inbox', 'inbox-backfill', 'pipeline']) {
        try {
          assertNoRunningRun(db, name);
        } catch (err) {
          throw Object.assign(new Error(`${err.message} Try again when it finishes.`), { statusCode: 409 });
        }
      }
      checkTaskId = tasks.start('inbox', {}, async (step, { logger }) => {
        const gmail = inbox.gmail({ onWait: (ms) => logger.warn(`Gmail rate limit reached; waiting ${ms / 1000} seconds, then continuing.`) });
        // A tracer per task, so the run's log lines also go to the task's output (the Activity tab).
        const run = createTracer({ store, logger }).startRun('inbox', { model: inbox.cfg.model });
        try {
          step('Reading new mail');
          const s = await runInbox({ store, gmail, claude, cfg: inbox.cfg, key: inbox.key(), run, log: run.log });
          for (const n of s.notices) logger.info(n);
          run.finish(s.failures.length ? 'partial' : 'ok', { ...s, notices: s.notices.length });
          step(`Done: ${s.considered} job emails, ${s.matched} linked, ${s.needsReview} to review`);
          return { considered: s.considered, matched: s.matched, needsReview: s.needsReview, opportunities: s.opportunities, statusChanges: s.statusChanges.length, notices: s.notices, failures: s.failures.length };
        } catch (err) {
          run.finish('failed', { error: err.message });
          throw err;
        }
      });
      return reply.code(202).send({ taskId: checkTaskId });
    },
  );

  app.post(
    '/api/inbox/emails/:id/review',
    {
      schema: {
        summary: 'Resolve an email that needs review: confirm the guess, reassign, not job related, or new opportunity',
        params: uuidParams,
        body: { type: 'object', required: ['choice'], additionalProperties: false, properties: { choice: { type: 'string', enum: CHOICES }, postingId: { type: 'integer', minimum: 1 } } },
        response: { 200: anyObject },
      },
    },
    async (req, reply) => {
      const e = listNeedsReview(db).find((x) => x.id === req.params.id);
      if (!e) return reply.code(404).send({ error: 'That email is not waiting for review.' });
      const { choice, postingId } = req.body;
      if (choice === 'reassign' && !postingId) return reply.code(400).send({ error: 'Choose the job to link it to.' });
      // The body is re-read from Gmail so a newly linked email keeps it (encrypted), as the inbox run would.
      let body = null;
      if (inbox.ready() && choice !== 'not_job') {
        const m = await inbox.gmail({ onWait: () => {} }).getMessage(e.gmail_message_id).catch(() => null);
        body = m ? trimBody(m.rawBody, { html: m.bodyIsHtml, max: inbox.cfg.bodyChars }) : null;
      }
      try {
        const r = resolveReview(db, e, choice, { postingId, body, key: body ? inbox.key() : null });
        return { postingId: r.postingId, statusChange: r.statusChange, review: r.review, notices: r.notices.filter((n) => !n.startsWith('Needs review')) };
      } catch (err) {
        return reply.code(400).send({ error: err.message });
      }
    },
  );

  app.patch(
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
      const r = db.prepare("UPDATE reminders SET status = ? WHERE id = ? AND status = 'open'").run(req.body.status, req.params.id);
      if (!r.changes) return reply.code(404).send({ error: 'Reminder not found or already closed.' });
      return { id: req.params.id, status: req.body.status };
    },
  );
}

