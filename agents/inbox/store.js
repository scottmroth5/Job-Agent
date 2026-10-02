// Database reads and writes for the inbox: emails, contacts, threads, the decision log, reminders.
import { randomUUID } from 'node:crypto';
import { domainIn } from './prefilter.js';

const iso = (d = new Date()) => d.toISOString();

export function insertEmail(db, e, now = new Date()) {
  const id = randomUUID();
  db.prepare(`INSERT INTO emails (id, gmail_message_id, thread_id, sender, sender_domain, sent_at, subject, type, posting_id, match_rule,
      confidence, review_status, review_reason, summary, extracted_json, body_enc, prompt_version, model, created_at, updated_at)
    VALUES (@id, @gmailMessageId, @threadId, @sender, @senderDomain, @sentAt, @subject, @type, @postingId, @matchRule,
      @confidence, @reviewStatus, @reviewReason, @summary, @extractedJson, @bodyEnc, @promptVersion, @model, @now, @now)`).run({
    id,
    gmailMessageId: e.gmailMessageId,
    threadId: e.threadId,
    sender: e.senderEmail,
    senderDomain: e.senderDomain,
    sentAt: e.sentAt,
    subject: e.subject ?? null,
    type: e.type ?? null,
    postingId: e.postingId ?? null,
    matchRule: e.matchRule ?? null,
    confidence: e.confidence ?? null,
    reviewStatus: e.reviewStatus,
    reviewReason: e.reviewReason ?? null,
    summary: e.summary ?? null,
    extractedJson: e.extracted ? JSON.stringify(e.extracted) : null,
    bodyEnc: e.bodyEnc ?? null,
    promptVersion: e.promptVersion ?? null,
    model: e.model ?? null,
    now: iso(now),
  });
  return id;
}

const EMAIL_COLUMNS = { postingId: 'posting_id', matchRule: 'match_rule', confidence: 'confidence', reviewStatus: 'review_status', reviewReason: 'review_reason', bodyEnc: 'body_enc', type: 'type' };

export function updateEmail(db, id, patch, now = new Date()) {
  const keys = Object.keys(patch).filter((k) => EMAIL_COLUMNS[k]);
  if (!keys.length) return;
  db.prepare(`UPDATE emails SET ${keys.map((k) => `${EMAIL_COLUMNS[k]} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...patch, id, now: iso(now) });
}

export const emailSeen = (db, gmailMessageId) => Boolean(db.prepare('SELECT 1 FROM emails WHERE gmail_message_id = ?').get(gmailMessageId));

export function logDecision(db, d, now = new Date()) {
  db.prepare(`INSERT INTO decision_log (id, posting_id, email_id, gmail_message_id, action, from_status, to_status, decided_by, prompt_version, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    randomUUID(),
    d.postingId ?? null,
    d.emailId ?? null,
    d.gmailMessageId ?? null,
    d.action,
    d.fromStatus ?? null,
    d.toStatus ?? null,
    d.decidedBy,
    d.promptVersion ?? null,
    d.detail ? JSON.stringify(d.detail) : null,
    iso(now),
  );
}

export function linkThread(db, threadId, postingId, kind = 'application', now = new Date()) {
  db.prepare(`INSERT INTO email_threads (thread_id, posting_id, kind, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (thread_id) DO UPDATE SET posting_id = excluded.posting_id`).run(threadId, postingId, kind, iso(now));
}

/** Adds or updates a contact; an existing link to an application is kept unless postingId is given. */
export function upsertContact(db, { email, name = null, company = null, postingId = null, source = 'email' }, now = new Date()) {
  const addr = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return null;
  db.prepare(`INSERT INTO contacts (id, email, name, company, posting_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (email) DO UPDATE SET name = COALESCE(excluded.name, name), company = COALESCE(excluded.company, company),
      posting_id = COALESCE(excluded.posting_id, posting_id), updated_at = excluded.updated_at`).run(randomUUID(), addr, name, company, postingId, source, iso(now), iso(now));
  return addr;
}

export const isContact = (db) => {
  const q = db.prepare('SELECT 1 FROM contacts WHERE email = ?');
  return (email) => Boolean(q.get(String(email ?? '').toLowerCase()));
};

export const isCompanyDomain = (db) => {
  const domains = db.prepare('SELECT DISTINCT company_domain FROM postings WHERE company_domain IS NOT NULL').pluck().all();
  return (domain) => domainIn(domain, domains);
};

/** Remembers the employer's own domain from a matched sender (never an ATS, job board, or personal mail domain). */
export function learnDomain(db, postingId, domain, { atsDomains, personalDomains = [] }) {
  const d = String(domain ?? '').toLowerCase();
  if (!d || domainIn(d, atsDomains) || domainIn(d, personalDomains)) return false;
  return db.prepare('UPDATE postings SET company_domain = ? WHERE id = ? AND company_domain IS NULL').run(d, postingId).changes > 0;
}

export function addReminder(db, { postingId, emailId, kind, dueAt = null, note = null }, now = new Date()) {
  const id = randomUUID();
  db.prepare('INSERT INTO reminders (id, posting_id, email_id, kind, due_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, postingId, emailId, kind, dueAt, note, iso(now));
  return id;
}
