// Home's Today list: the work waiting on the user, soonest first. Open reminders (assessments and interviews, from
// the inbox) due in the next REMINDER_DAYS or already past; jobs at an offer (the status group "decision", not
// archived); applications with no reply worth a follow-up (agents/follow-ups.js: from FOLLOW_UP_DAYS until the user's
// stale days, not archived; the same rule as the Funnel's list); and stale ones to close as no response: on Home one
// item for all of them, in a job's Next step box that job.
// Each item opens its job. Built from status groups, so statuses added later count automatically.
// With jobId it is one job's next steps (the job panel's Next step box): every open reminder, however far out.
import { lookups, sqlList } from '../agents/lookups.js';
import { waitingApplications } from '../agents/follow-ups.js';

export const REMINDER_DAYS = 14;
const DAY = 24 * 3600 * 1000;

/** The Today list for the current user, or one job's: { items: [{ kind, jobId, company, title, text, id?, due?, overdue?, days? }] }. */
export function today(db, { now = new Date(), jobId = null } = {}) {
  const one = jobId == null ? '' : 'AND p.id = @jobId';
  const params = jobId == null ? {} : { jobId: Number(jobId) };
  const lk = lookups(db);
  const horizon = new Date(now.getTime() + REMINDER_DAYS * DAY).toISOString();
  const reminders = db
    .prepare(
      `SELECT r.id, r.kind, r.due_at AS due, r.note, p.id AS jobId, p.company, p.title
       FROM reminders r JOIN postings p ON p.id = r.posting_id AND p.user_id = r.user_id
       WHERE r.user_id = @uid AND r.status = 'open' AND (r.due_at IS NULL OR r.due_at <= @horizon OR @all = 1) ${one}
       ORDER BY r.due_at IS NULL, r.due_at`,
    )
    .all({ horizon, all: jobId == null ? 0 : 1, ...params })
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      jobId: r.jobId,
      company: r.company,
      title: r.title,
      text: r.note || (r.kind === 'interview' ? 'Interview' : 'Assessment'),
      due: r.due ?? null,
      overdue: Boolean(r.due && r.due < now.toISOString()),
    }));
  const decision = lk.ids('status', 'decision');
  const offers = decision.length
    ? db
        .prepare(
          `SELECT p.id AS jobId, p.company, p.title, p.status FROM postings p
           WHERE p.user_id = @uid AND p.status IN ${sqlList(decision)} AND p.stage NOT IN ${sqlList(lk.ids('stage', 'archived'))} ${one}
           ORDER BY p.id DESC`,
        )
        .all(params)
        .map((p) => ({ kind: 'offer', jobId: p.jobId, company: p.company, title: p.title, text: `${lk.label('status', p.status)}: decide and reply` }))
    : [];
  const waiting = waitingApplications(db, { now });
  const mine = (a) => jobId == null || a.id === Number(jobId);
  const followUps = waiting.followUp
    .filter(mine)
    .map((a) => ({ kind: 'follow_up', jobId: a.id, company: a.company, title: a.title, text: `No reply in ${a.waitingDays} days: reach a person there`, days: a.waitingDays }));
  const staleOnes = waiting.stale.filter(mine);
  const stale =
    jobId != null
      ? staleOnes.map((a) => ({ kind: 'stale', jobId: a.id, company: a.company, title: a.title, text: `No reply in ${a.waitingDays} days: close it as no response`, days: a.waitingDays }))
      : staleOnes.length
        ? [{ kind: 'stale', count: staleOnes.length, staleDays: waiting.staleDays, text: `${staleOnes.length === 1 ? '1 application' : `${staleOnes.length} applications`} with no reply after ${waiting.staleDays} days or more` }]
        : [];
  // Past-due reminders first, then offers, then the rest of the reminders by date, then follow-ups, oldest first, then
  // the stale ones.
  return { items: [...reminders.filter((r) => r.overdue), ...offers, ...reminders.filter((r) => !r.overdue), ...followUps, ...stale] };
}
