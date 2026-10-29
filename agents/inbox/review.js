// Resolving emails marked needs_review. Each choice is logged as the user's decision and saved as a
// labeled case for the inbox eval (data/evals/inbox, gitignored). A case's email text is sealed with EMAIL_ENC_KEY
// (bodyEnc), never written in the clear; scripts/inbox-seal-cases.js seals cases written before that.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../../tools/paths.js';
import { applyActions, createOpportunity } from './actions.js';
import { updateEmail, logDecision } from './store.js';
import { encrypt } from './crypto.js';
import { listOpenApplications } from './match.js';

export const REVIEW_CASES_PATH = dataPath('evals', 'inbox', 'review-cases.jsonl');
export const CHOICES = ['confirm', 'reassign', 'not_job', 'opportunity'];

const parse = (s) => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

/** Emails waiting for review, oldest first, with the best-guess application when there is one. */
export function listNeedsReview(db) {
  return db
    .prepare("SELECT * FROM emails WHERE user_id = @uid AND review_status = 'needs_review' ORDER BY sent_at, id")
    .all()
    .map((e) => {
      const extracted = parse(e.extracted_json);
      const guessId = e.posting_id ?? extracted.best_guess_application_id ?? null;
      const guess = guessId ? db.prepare('SELECT id, company, title, status FROM postings WHERE id = ? AND user_id = @uid').get(guessId) ?? null : null;
      return { ...e, extracted, guess };
    });
}

/** The stored classification, in the shape actions expect. */
const classificationOf = (e) => ({
  type: e.type ?? 'other',
  extracted: { company: null, role_title: null, contact_name: null, contact_email: null, interview_times: [], deadline: null, ...e.extracted },
  summary: e.summary ?? '',
});

/**
 * Applies one review choice.
 * @param {object} e        a row from listNeedsReview
 * @param {string} choice   'confirm' | 'reassign' | 'not_job' | 'opportunity'
 * @param {{ postingId?: number, body?: string, key?: Buffer, now?: Date, casesPath?: string }} opts
 *   body: the trimmed email text (re-read from Gmail), stored encrypted when the email gets linked
 * @returns {{ postingId: number|null, statusChange: object|null, review: string|null, notices: string[] }}
 */
export function resolveReview(db, e, choice, { postingId, body = null, key = null, now = new Date(), casesPath = REVIEW_CASES_PATH } = {}) {
  if (!CHOICES.includes(choice)) throw new Error(`Unknown review choice: ${choice}`);
  const c = classificationOf(e);
  const email = { id: e.id, gmailMessageId: e.gmail_message_id, threadId: e.thread_id, sentAt: e.sent_at, senderEmail: e.sender };
  const open = listOpenApplications(db);
  let out = { postingId: null, statusChange: null, review: null, notices: [] };

  db.transaction(() => {
    if (choice === 'confirm' || choice === 'reassign') {
      const target = choice === 'confirm' ? e.guess?.id : postingId;
      if (!target || !db.prepare('SELECT 1 FROM postings WHERE id = ? AND user_id = @uid').get(target)) throw new Error(choice === 'confirm' ? 'There is no best guess to confirm; reassign instead.' : `Job #${postingId} was not found.`);
      const r = applyActions(db, { email, postingId: target, c, decidedBy: 'user', promptVersion: e.prompt_version, now });
      updateEmail(db, e.id, { postingId: target, matchRule: 'user', confidence: 1, reviewStatus: choice === 'confirm' ? 'confirmed' : 'reassigned', reviewReason: null, ...(body && key && !e.body_enc ? { bodyEnc: encrypt(body, key) } : {}) }, now);
      out = { postingId: target, ...r };
    } else if (choice === 'not_job') {
      updateEmail(db, e.id, { postingId: null, matchRule: null, reviewStatus: 'not_job', reviewReason: null, bodyEnc: null }, now);
    } else {
      const id = createOpportunity(db, { email, c, decidedBy: 'user', promptVersion: e.prompt_version, now });
      updateEmail(db, e.id, { postingId: id, matchRule: 'user', reviewStatus: 'new_opportunity', reviewReason: null, ...(body && key ? { bodyEnc: encrypt(body, key) } : {}) }, now);
      out = { ...out, postingId: id };
    }
    logDecision(db, { postingId: out.postingId, emailId: e.id, gmailMessageId: e.gmail_message_id, action: `review:${choice}`, decidedBy: 'user', promptVersion: e.prompt_version, detail: { previousGuess: e.guess?.id ?? null } }, now);
  })();

  saveEvalCase(casesPath, {
    gmailMessageId: e.gmail_message_id,
    sender: e.sender,
    sentAt: e.sent_at,
    subject: e.subject,
    bodyEnc: caseBody(body, key, choice),
    open: open.map(({ id, company, title }) => ({ id, company, title })),
    modelGuess: { applicationId: e.guess?.id ?? null, type: e.type, confidence: e.confidence },
    label: { applicationId: choice === 'not_job' ? null : out.postingId, relevant: choice !== 'not_job', type: choice === 'not_job' ? 'other' : e.type, opportunity: choice === 'opportunity' },
    labeledAt: now.toISOString(),
  });
  return out;
}

/**
 * An eval case's email text, sealed like a linked email's body (EMAIL_ENC_KEY), so the case file never holds email text
 * in the clear. A "not a job email" case keeps none: the inbox stores nothing about other mail. No key, no text.
 */
export function caseBody(body, key, choice) {
  return body && key && choice !== 'not_job' ? encrypt(body, key) : null;
}

/**
 * Seals the case file's text written before bodyEnc: each record with a plain body gets bodyEnc (none for a "not a job
 * email" case) and loses body. Returns the new file text and counts; records already sealed are left as they are.
 */
export function sealCaseLines(text, key) {
  const counts = { cases: 0, sealed: 0, dropped: 0 };
  const lines = String(text ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      counts.cases += 1;
      const record = JSON.parse(line);
      if (!Object.hasOwn(record, 'body')) return line;
      const { body, ...rest } = record;
      const bodyEnc = rest.bodyEnc ?? caseBody(body, key, rest.label?.relevant === false ? 'not_job' : 'linked');
      if (body) counts[bodyEnc ? 'sealed' : 'dropped'] += 1;
      return JSON.stringify({ ...rest, bodyEnc });
    });
  return { text: lines.length ? `${lines.join('\n')}\n` : '', counts };
}

export function saveEvalCase(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
