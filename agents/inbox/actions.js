// What a classified email does: link it (or send it to review), move the application forward, and record
// why. Status only ever moves forward automatically; anything else is flagged for review instead.
import { storedKey } from '../identity.js';
import { logDecision, linkThread, upsertContact, addReminder } from './store.js';

export const STATUS_RANK = { new: 0, applied: 1, interviewing: 2, offer: 3 };
const CLOSED = ['passed', 'closed', 'rejected'];
const TARGET = { confirmation: 'applied', rejection: 'rejected', interview_request: 'interviewing', offer: 'offer' };
// Types that are about an application; without a confident link they need a person to place them.
const APPLICATION_TYPES = ['confirmation', 'rejection', 'interview_request', 'assessment', 'offer', 'follow_up'];

/**
 * The confidence gate. A rule match counts as certain. Returns
 *   { postingId, rule, confidence, reviewStatus: 'auto' | 'needs_review', reason, bestGuess, opportunity }
 */
export function decideLink({ ruleMatch, classification: c, threshold }) {
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
 */
export function planStatus(current, type) {
  const to = TARGET[type];
  if (!to || to === current) return { none: true };
  if (CLOSED.includes(current)) return { review: `the application is ${current}; a ${type.replace('_', ' ')} email would reopen it` };
  if (to === 'rejected') return current === 'offer' ? { review: 'a rejection arrived after an offer' } : { change: { from: current, to } };
  if (STATUS_RANK[to] > STATUS_RANK[current]) return { change: { from: current, to } };
  return { review: `would move the status backward (${current} to ${to})` };
}

const dateOnly = (iso) => String(iso ?? '').slice(0, 10) || null;

/** An ISO date from text like "October 9, 2026" or "2026-10-09", else null (the text is kept in the note). */
export function parseDeadline(text) {
  if (!text) return null;
  const t = Date.parse(String(text).replace(/(\d)(st|nd|rd|th)\b/g, '$1'));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Runs the actions for a linked email. email: the stored row's fields (id, gmailMessageId, threadId, sentAt,
 * senderEmail); c: the validated classification; decidedBy: 'rule:<name>' | 'model:<id>' | 'user'.
 * Returns { statusChange, review, notices[], reminderId }.
 */
export function applyActions(db, { email, postingId, c, decidedBy, promptVersion, now = new Date() }) {
  const posting = db.prepare('SELECT id, company, title, status, applied_on FROM postings WHERE id = ?').get(postingId);
  if (!posting) return { statusChange: null, review: 'the application no longer exists', notices: [], reminderId: null };
  const nowIso = now.toISOString();
  const base = { postingId, emailId: email.id, gmailMessageId: email.gmailMessageId, decidedBy, promptVersion };
  const label = `${posting.title} at ${posting.company}`;
  const notices = [];
  let reminderId = null;

  linkThread(db, email.threadId, postingId, 'application', now);
  logDecision(db, { ...base, action: 'link', detail: { type: c.type } }, now);
  if (c.extracted.contact_email || email.senderEmail) {
    const personal = c.extracted.contact_email ?? (/no-?reply|notifications?@/i.test(email.senderEmail) ? null : email.senderEmail);
    if (personal) upsertContact(db, { email: personal, name: c.extracted.contact_name, company: posting.company, postingId }, now);
  }

  const plan = planStatus(posting.status, c.type);
  let statusChange = null;
  if (plan.change) {
    const { from, to } = plan.change;
    db.transaction(() => {
      const appliedOn = to === 'applied' && !posting.applied_on ? dateOnly(email.sentAt) : posting.applied_on;
      db.prepare('UPDATE postings SET status = ?, applied_on = ?, updated_at = ? WHERE id = ?').run(to, appliedOn, nowIso, postingId);
      db.prepare("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, ?, ?, 'agent', ?)").run(postingId, from, to, nowIso);
      logDecision(db, { ...base, action: 'status_change', fromStatus: from, toStatus: to, detail: { emailDate: email.sentAt, type: c.type } }, now);
    })();
    statusChange = plan.change;
  } else if (plan.review) {
    logDecision(db, { ...base, action: 'needs_review', detail: { reason: plan.review, type: c.type } }, now);
  }

  if (c.type === 'interview_request') {
    const times = c.extracted.interview_times;
    reminderId = addReminder(db, { postingId, emailId: email.id, kind: 'interview', dueAt: parseDeadline(times[0]), note: times.length ? `Proposed: ${times.join('; ')}` : 'Reply to schedule' }, now);
    notices.push(`INTERVIEW REQUEST: ${label}${times.length ? ` (proposed: ${times.join('; ')})` : ''}${c.extracted.contact_name ? `, from ${c.extracted.contact_name}` : ''}`);
  }
  if (c.type === 'assessment') {
    reminderId = addReminder(db, { postingId, emailId: email.id, kind: 'assessment', dueAt: parseDeadline(c.extracted.deadline), note: c.extracted.deadline ? `Due: ${c.extracted.deadline}` : 'No deadline stated' }, now);
    logDecision(db, { ...base, action: 'reminder', detail: { deadline: c.extracted.deadline } }, now);
    notices.push(`ASSESSMENT: ${label}${c.extracted.deadline ? `, due ${c.extracted.deadline}` : ''}`);
  }
  if (c.type === 'offer' && statusChange) notices.push(`OFFER: ${label}`);
  if (plan.review) notices.push(`Needs review: ${label}: ${plan.review}`);
  return { statusChange, review: plan.review ?? null, notices, reminderId };
}

/** A new opportunity from recruiter outreach that matches no application. The email body is not copied. */
export function createOpportunity(db, { email, c, decidedBy, promptVersion, now = new Date() }) {
  const nowIso = now.toISOString();
  const company = c.extracted.company ?? 'Unknown';
  const title = c.extracted.role_title ?? 'Recruiter outreach';
  const notes = `From a recruiter email on ${dateOnly(email.sentAt)}: ${c.summary}\nGmail thread: https://mail.google.com/mail/u/0/#all/${email.threadId}`;
  const id = Number(
    db
      .prepare(`INSERT INTO postings (company, title, company_title_key, source, discovered_on, stage, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, 'email', ?, 'discovered', 'new', ?, ?, ?)`)
      .run(company, title, storedKey({ company, title }), nowIso.slice(0, 10), notes, nowIso, nowIso).lastInsertRowid,
  );
  db.prepare("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, NULL, 'new', 'agent', ?)").run(id, nowIso);
  linkThread(db, email.threadId, id, 'outreach', now);
  upsertContact(db, { email: c.extracted.contact_email ?? email.senderEmail, name: c.extracted.contact_name, company, postingId: id }, now);
  logDecision(db, { postingId: id, emailId: email.id, gmailMessageId: email.gmailMessageId, action: 'opportunity', decidedBy, promptVersion, detail: { company, title } }, now);
  return id;
}
