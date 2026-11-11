// Database reads and writes for the inbox: emails, contacts, threads, the decision log, reminders.
import { asEngine } from '../../db/engine/index.ts';
import { randomUUID } from 'node:crypto';
import { domainIn } from './prefilter.ts';
import type { Database } from '../../tools/types.ts';

/** An email as the inbox stores it: the message's fields plus what matching and classifying decided. */
export interface EmailRecord {
  gmailMessageId: string;
  threadId: string;
  senderEmail: string;
  senderDomain: string;
  sentAt: string;
  subject?: string | null;
  type?: string | null;
  postingId?: number | null;
  matchRule?: string | null;
  confidence?: number | null;
  reviewStatus: string;
  reviewReason?: string | null;
  summary?: string | null;
  extracted?: object | null;
  bodyEnc?: string | null;
  promptVersion?: string | null;
  model?: string | null;
}

/** The email fields updateEmail may change. */
export type EmailPatch = Partial<Pick<EmailRecord, 'postingId' | 'matchRule' | 'confidence' | 'reviewStatus' | 'reviewReason' | 'bodyEnc' | 'type'>>;

/** One entry in decision_log. */
export interface Decision {
  postingId?: number | null;
  emailId?: string | null;
  gmailMessageId?: string | null;
  action: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  decidedBy: string;
  promptVersion?: string | null;
  detail?: object | null;
}

const iso = (d = new Date()) => d.toISOString();

export async function insertEmail(db: Database, e: EmailRecord, now = new Date()) {
  const id = randomUUID();
  await asEngine(db).prepare(`INSERT INTO emails (user_id, id, gmail_message_id, thread_id, sender, sender_domain, sent_at, subject, type, posting_id, match_rule,
      confidence, review_status, review_reason, summary, extracted_json, body_enc, prompt_version, model, created_at, updated_at)
    VALUES (@uid, @id, @gmailMessageId, @threadId, @sender, @senderDomain, @sentAt, @subject, @type, @postingId, @matchRule,
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

const EMAIL_COLUMNS: Record<string, string> = { postingId: 'posting_id', matchRule: 'match_rule', confidence: 'confidence', reviewStatus: 'review_status', reviewReason: 'review_reason', bodyEnc: 'body_enc', type: 'type' };

export async function updateEmail(db: Database, id: string, patch: EmailPatch, now = new Date()) {
  const keys = Object.keys(patch).filter((k) => EMAIL_COLUMNS[k]);
  if (!keys.length) return;
  await asEngine(db).prepare(`UPDATE emails SET ${keys.map((k) => `${EMAIL_COLUMNS[k]} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id AND user_id = @uid`).run({ ...patch, id, now: iso(now) });
}

export const emailSeen = async (db: Database, gmailMessageId: string) => Boolean(await asEngine(db).prepare('SELECT 1 FROM emails WHERE gmail_message_id = ? AND user_id = @uid').get(gmailMessageId));

export async function logDecision(db: Database, d: Decision, now = new Date()) {
  await asEngine(db).prepare(`INSERT INTO decision_log (user_id, id, posting_id, email_id, gmail_message_id, action, from_status, to_status, decided_by, prompt_version, detail_json, created_at)
    VALUES (@uid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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

export async function linkThread(db: Database, threadId: string, postingId: number, kind = 'application', now = new Date()) {
  await asEngine(db).prepare(`INSERT INTO email_threads (user_id, thread_id, posting_id, kind, created_at) VALUES (@uid, ?, ?, ?, ?)
    ON CONFLICT (user_id, thread_id) DO UPDATE SET posting_id = excluded.posting_id`).run(threadId, postingId, kind, iso(now));
}

/** Adds or updates a contact; an existing link to an application is kept unless postingId is given. */
export async function upsertContact(
  db: Database,
  { email, name = null, company = null, postingId = null, source = 'email' }: { email: string | null | undefined; name?: string | null; company?: string | null; postingId?: number | null; source?: string },
  now = new Date(),
) {
  const addr = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return null;
  await asEngine(db).prepare(`INSERT INTO contacts (user_id, id, email, name, company, posting_id, source, created_at, updated_at) VALUES (@uid, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, email) DO UPDATE SET name = COALESCE(excluded.name, name), company = COALESCE(excluded.company, company),
      posting_id = COALESCE(excluded.posting_id, posting_id), updated_at = excluded.updated_at`).run(randomUUID(), addr, name, company, postingId, source, iso(now), iso(now));
  return addr;
}

/** A check of known contacts, from the contacts as they are now (the pre-filter's checks answer at once). */
export const isContact = async (db: Database) => {
  const emails = new Set((await asEngine(db).prepare('SELECT email FROM contacts WHERE user_id = @uid').pluck().all()) as string[]);
  return (email: string | null | undefined) => emails.has(String(email ?? '').toLowerCase());
};

export const isCompanyDomain = async (db: Database) => {
  const domains = await asEngine(db).prepare('SELECT DISTINCT company_domain FROM postings WHERE user_id = @uid AND company_domain IS NOT NULL').pluck().all() as string[];
  return (domain: string) => domainIn(domain, domains);
};

/** Remembers the employer's own domain from a matched sender (never an ATS, job board, or personal mail domain). */
export async function learnDomain(db: Database, postingId: number, domain: string | null | undefined, { atsDomains, personalDomains = [] }: { atsDomains: string[]; personalDomains?: string[] }) {
  const d = String(domain ?? '').toLowerCase();
  if (!d || domainIn(d, atsDomains) || domainIn(d, personalDomains)) return false;
  return (await asEngine(db).prepare('UPDATE postings SET company_domain = ? WHERE id = ? AND user_id = @uid AND company_domain IS NULL').run(d, postingId)).changes > 0;
}

export async function addReminder(
  db: Database,
  { postingId, emailId, kind, dueAt = null, note = null }: { postingId: number; emailId: string | null; kind: string; dueAt?: string | null; note?: string | null },
  now = new Date(),
) {
  const id = randomUUID();
  await asEngine(db).prepare('INSERT INTO reminders (user_id, id, posting_id, email_id, kind, due_at, note, created_at) VALUES (@uid, ?, ?, ?, ?, ?, ?, ?)').run(id, postingId, emailId, kind, dueAt, note, iso(now));
  return id;
}
