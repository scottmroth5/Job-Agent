// What a classified email does: link it (or send it to review), move the application forward, and record
// why. Status only ever moves forward automatically; anything else is flagged for review instead.
import { storedKey } from '../identity.ts';
import { logDecision, linkThread, upsertContact, addReminder } from './store.ts';
import { builtInLookups, lookups } from '../lookups.ts';
import { adoptNotesText } from '../notes.ts';
import { localDay } from '../../tools/dates.ts';
import type { Db } from '../../tools/types.ts';
import type { Lookups } from '../lookups.ts';
import type { Classification } from './classify.ts';

/** decideLink's answer: the link to make (or not), and whether a person must look. */
export interface LinkDecision {
  postingId: number | null;
  rule: string | null;
  confidence: number;
  reviewStatus: 'auto' | 'needs_review';
  reason: string | null;
  bestGuess: number | null;
  opportunity: boolean;
}

/** planStatus's answer: one of a forward change, a reason for review, or nothing to do. */
export type StatusPlan = { change: { from: string; to: string }; review?: undefined; none?: undefined } | { review: string; change?: undefined; none?: undefined } | { none: true; change?: undefined; review?: undefined };

/** What the actions read from a classification (a stored one, from review, has no confidence or application). */
type ActionClassification = Pick<Classification, 'type' | 'extracted' | 'summary'>;

/** The stored email an action works from. */
type ActionEmail = { id: string; gmailMessageId: string; threadId: string; sentAt: string; senderEmail: string };

// The status role each email type moves a job to (Admin > Lists); ranks and closed statuses come from status groups (agents/lookups.ts).
const TARGET: Record<string, string> = { confirmation: 'applied', rejection: 'rejected', interview_request: 'interview', offer: 'offer' };
// Types that are about an application; without a confident link they need a person to place them.
const APPLICATION_TYPES = ['confirmation', 'rejection', 'interview_request', 'assessment', 'offer', 'follow_up'];

/**
 * The confidence gate. A rule match counts as certain.
 */
export function decideLink({ ruleMatch, classification: c, threshold }: { ruleMatch?: { postingId: number; rule: string } | null; classification: Pick<Classification, 'applicationId' | 'confidence' | 'type'>; threshold: number }): LinkDecision {
  if (ruleMatch) return { postingId: ruleMatch.postingId, rule: ruleMatch.rule, confidence: 1, reviewStatus: 'auto', reason: null, bestGuess: null, opportunity: false };
  if (c.applicationId != null) {
    if (c.confidence >= threshold) return { postingId: c.applicationId, rule: 'model', confidence: c.confidence, reviewStatus: 'auto', reason: null, bestGuess: null, opportunity: false };
    return { postingId: null, rule: null, confidence: c.confidence, reviewStatus: 'needs_review', reason: `low confidence (${c.confidence.toFixed(2)})`, bestGuess: c.applicationId, opportunity: false };
  }
  if (c.type === 'recruiter_outreach') {
    if (c.confidence >= threshold) return { postingId: null, rule: null, confidence: c.confidence, reviewStatus: 'auto', reason: null, bestGuess: null, opportunity: true };
    return { postingId: null, rule: null, confidence: c.confidence, reviewStatus: 'needs_review', reason: 'outreach that may be about an existing application', bestGuess: null, opportunity: false };
  }
  if (APPLICATION_TYPES.includes(c.type)) return { postingId: null, rule: null, confidence: c.confidence, reviewStatus: 'needs_review', reason: `${c.type} with no matching application`, bestGuess: null, opportunity: false };
  return { postingId: null, rule: null, confidence: c.confidence, reviewStatus: 'auto', reason: null, bestGuess: null, opportunity: false };
}

/**
 * The status change an email type implies for an application in `current` status:
 *   { change: { from, to } } | { review: reason } | { none: true }
 * lk: lookups(db), or the built-in lists when omitted. An archived target status sends the email to review.
 */
export function planStatus(current: string, type: string, lk: Lookups = builtInLookups()): StatusPlan {
  const role = TARGET[type];
  const to = role ? lk.role('status', role) : null;
  if (!to || to === current) return { none: true };
  if (!lk.selectable('status', to)) return { review: `the "${lk.label('status', to)}" status is archived, so it was not set` };
  if (lk.isClosed(current)) return { review: `the application is ${current}; a ${type.replace('_', ' ')} email would reopen it` };
  if (role === 'rejected') return lk.groupOf('status', current) === 'decision' ? { review: 'a rejection arrived after an offer' } : { change: { from: current, to } };
  const [rankTo, rankNow] = [lk.rank(to), lk.rank(current)];
  if (rankTo != null && rankNow != null && rankTo > rankNow) return { change: { from: current, to } };
  return { review: `would move the status backward (${current} to ${to})` };
}

const dateOnly = (iso: string | null | undefined) => String(iso ?? '').slice(0, 10) || null;

/** An ISO date from text like "October 9, 2026" or "2026-10-09", else null (the text is kept in the note). */
export function parseDeadline(text: string | null | undefined) {
  if (!text) return null;
  const t = Date.parse(String(text).replace(/(\d)(st|nd|rd|th)\b/g, '$1'));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Runs the actions for a linked email. email: the stored row's fields (id, gmailMessageId, threadId, sentAt,
 * senderEmail); c: the validated classification; decidedBy: 'rule:<name>' | 'model:<id>' | 'user'.
 * Returns { statusChange, review, notices[], reminderId }.
 */
export async function applyActions(
  db: Db,
  { email, postingId, c, decidedBy, promptVersion, now = new Date() }: { email: ActionEmail; postingId: number; c: ActionClassification; decidedBy: string; promptVersion?: string | null; now?: Date },
) {
  const posting = await db.prepare('SELECT id, company, title, status, stage, applied_on FROM postings WHERE id = ? AND user_id = @uid').get(postingId) as
    | { id: number; company: string; title: string; status: string; stage: string; applied_on: string | null }
    | undefined;
  if (!posting) return { statusChange: null, review: 'the application no longer exists', notices: [], reminderId: null };
  const nowIso = now.toISOString();
  const base = { postingId, emailId: email.id, gmailMessageId: email.gmailMessageId, decidedBy, promptVersion };
  const label = `${posting.title} at ${posting.company}`;
  const notices: string[] = [];
  let reminderId: string | null = null;

  await linkThread(db, email.threadId, postingId, 'application', now);
  await logDecision(db, { ...base, action: 'link', detail: { type: c.type } }, now);
  if (c.extracted.contact_email || email.senderEmail) {
    const personal = c.extracted.contact_email ?? (/no-?reply|notifications?@/i.test(email.senderEmail) ? null : email.senderEmail);
    if (personal) await upsertContact(db, { email: personal, name: c.extracted.contact_name, company: posting.company, postingId }, now);
  }

  const lk = await lookups(db);
  const plan = planStatus(posting.status, c.type, lk);
  let statusChange: { from: string; to: string } | null = null;
  if (plan.change) {
    const { from, to } = plan.change;
    await db.tx(async () => {
      const appliedOn = lk.groupOf('status', to) === 'waiting' && !posting.applied_on ? dateOnly(email.sentAt) : posting.applied_on;
      const stage = lk.isClosed(to) ? lk.role('stage', 'archive') : posting.stage;
      await db.prepare('UPDATE postings SET status = ?, applied_on = ?, stage = ?, updated_at = ? WHERE id = ? AND user_id = @uid').run(to, appliedOn, stage, nowIso, postingId);
      await db.prepare("INSERT INTO status_history (user_id, posting_id, from_status, to_status, changed_by, changed_at) VALUES (@uid, ?, ?, ?, 'agent', ?)").run(postingId, from, to, nowIso);
      await logDecision(db, { ...base, action: 'status_change', fromStatus: from, toStatus: to, detail: { emailDate: email.sentAt, type: c.type } }, now);
    });
    statusChange = plan.change;
  } else if (plan.review) {
    await logDecision(db, { ...base, action: 'needs_review', detail: { reason: plan.review, type: c.type } }, now);
  }

  if (c.type === 'interview_request') {
    const times = c.extracted.interview_times;
    reminderId = await addReminder(db, { postingId, emailId: email.id, kind: 'interview', dueAt: parseDeadline(times[0]), note: times.length ? `Proposed: ${times.join('; ')}` : 'Reply to schedule' }, now);
    notices.push(`INTERVIEW REQUEST: ${label}${times.length ? ` (proposed: ${times.join('; ')})` : ''}${c.extracted.contact_name ? `, from ${c.extracted.contact_name}` : ''}`);
  }
  if (c.type === 'assessment') {
    reminderId = await addReminder(db, { postingId, emailId: email.id, kind: 'assessment', dueAt: parseDeadline(c.extracted.deadline), note: c.extracted.deadline ? `Due: ${c.extracted.deadline}` : 'No deadline stated' }, now);
    await logDecision(db, { ...base, action: 'reminder', detail: { deadline: c.extracted.deadline } }, now);
    notices.push(`ASSESSMENT: ${label}${c.extracted.deadline ? `, due ${c.extracted.deadline}` : ''}`);
  }
  if (c.type === 'offer' && statusChange) notices.push(`OFFER: ${label}`);
  if (plan.review) notices.push(`Needs review: ${label}: ${plan.review}`);
  return { statusChange, review: plan.review ?? null, notices, reminderId };
}

/** A new opportunity from recruiter outreach that matches no application. The email body is not copied. */
export async function createOpportunity(
  db: Db,
  { email, c, decidedBy, promptVersion, now = new Date() }: { email: ActionEmail; c: ActionClassification; decidedBy: string; promptVersion?: string | null; now?: Date },
) {
  const lk = await lookups(db);
  const nowIso = now.toISOString();
  const company = c.extracted.company ?? 'Unknown';
  const title = c.extracted.role_title ?? 'Recruiter outreach';
  const notes = `From a recruiter email on ${dateOnly(email.sentAt)}: ${c.summary}\nGmail thread: https://mail.google.com/mail/u/0/#all/${email.threadId}`;
  const id = Number(
    (await db
      .prepare(`INSERT INTO postings (user_id, company, title, company_title_key, source, discovered_on, stage, status, notes, created_at, updated_at)
        VALUES (@uid, ?, ?, ?, 'email', ?, ?, ?, ?, ?, ?) RETURNING id`)
      .run(company, title, storedKey({ company, title }), localDay(now), lk.role('stage', 'default'), lk.role('status', 'default'), notes, nowIso, nowIso)).id,
  );
  await db.prepare("INSERT INTO status_history (user_id, posting_id, from_status, to_status, changed_by, changed_at) VALUES (@uid, ?, NULL, ?, 'agent', ?)").run(id, lk.role('status', 'default'), nowIso);
  await adoptNotesText(db, { postingId: id, source: 'agent', now });
  await linkThread(db, email.threadId, id, 'outreach', now);
  await upsertContact(db, { email: c.extracted.contact_email ?? email.senderEmail, name: c.extracted.contact_name, company, postingId: id }, now);
  await logDecision(db, { postingId: id, emailId: email.id, gmailMessageId: email.gmailMessageId, action: 'opportunity', decidedBy, promptVersion, detail: { company, title } }, now);
  return id;
}
