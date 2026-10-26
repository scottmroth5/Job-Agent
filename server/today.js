// Home's Today list: the work waiting on the user, soonest first. Open reminders (assessments and interviews, from
// the inbox) due in the next REMINDER_DAYS or already past; jobs at an offer (the status group "decision", not
// archived); and applications with no reply after FOLLOW_UP_DAYS (the same rule as the Funnel's follow-up list).
// Each item opens its job. Built from status groups, so statuses added later count automatically.
import { lookups, sqlList } from '../agents/lookups.js';
import { applications, FOLLOW_UP_DAYS } from './funnel.js';

export const REMINDER_DAYS = 14;
const DAY = 24 * 3600 * 1000;

/** The Today list for the current user: { items: [{ kind, jobId, company, title, text, due?, days? }] }. */
export function today(db, { now = new Date() } = {}) {
  const lk = lookups(db);
  const horizon = new Date(now.getTime() + REMINDER_DAYS * DAY).toISOString();
  const reminders = db
    .prepare(
      `SELECT r.kind, r.due_at AS due, r.note, p.id AS jobId, p.company, p.title
       FROM reminders r JOIN postings p ON p.id = r.posting_id AND p.user_id = r.user_id
       WHERE r.user_id = @uid AND r.status = 'open' AND (r.due_at IS NULL OR r.due_at <= ?)
       ORDER BY r.due_at IS NULL, r.due_at`,
    )
    .all(horizon)
    .map((r) => ({
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
           WHERE p.user_id = @uid AND p.status IN ${sqlList(decision)} AND p.stage NOT IN ${sqlList(lk.ids('stage', 'archived'))}
           ORDER BY p.id DESC`,
        )
        .all()
        .map((p) => ({ kind: 'offer', jobId: p.jobId, company: p.company, title: p.title, text: `${lk.label('status', p.status)}: decide and reply` }))
    : [];
  const followUps = applications(db, { now })
    .filter((a) => !a.responded.reached && !a.closed && a.waitingDays >= FOLLOW_UP_DAYS)
    .sort((a, b) => b.waitingDays - a.waitingDays)
    .map((a) => ({ kind: 'follow_up', jobId: a.id, company: a.company, title: a.title, text: `No reply in ${a.waitingDays} days: send a follow-up`, days: a.waitingDays }));
  // Past-due reminders first, then offers, then the rest of the reminders by date, then follow-ups, oldest first.
  return { items: [...reminders.filter((r) => r.overdue), ...offers, ...reminders.filter((r) => !r.overdue), ...followUps] };
}
