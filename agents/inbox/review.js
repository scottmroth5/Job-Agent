// Resolving emails marked needs_review. Each choice is logged as the user's decision and saved as a
// labeled case for the inbox eval (data/evals/inbox, gitignored, since it holds real email text).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { repoPath } from '../../tools/paths.js';
import { applyActions, createOpportunity } from './actions.js';
import { updateEmail, logDecision } from './store.js';
import { encrypt } from './crypto.js';
import { listOpenApplications } from './match.js';

export const REVIEW_CASES_PATH = repoPath('data', 'evals', 'inbox', 'review-cases.jsonl');
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
    .prepare("SELECT * FROM emails WHERE review_status = 'needs_review' ORDER BY sent_at, id")
    .all()
    .map((e) => {
      const extracted = parse(e.extracted_json);
      const guessId = e.posting_id ?? extracted.best_guess_application_id ?? null;
      const guess = guessId ? db.prepare('SELECT id, company, title, status FROM postings WHERE id = ?').get(guessId) ?? null : null;
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
      if (!target || !db.prepare('SELECT 1 FROM postings WHERE id = ?').get(target)) throw new Error(choice === 'confirm' ? 'There is no best guess to confirm; reassign instead.' : `Job #${postingId} was not found.`);
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
    body,
    open: open.map(({ id, company, title }) => ({ id, company, title })),
    modelGuess: { applicationId: e.guess?.id ?? null, type: e.type, confidence: e.confidence },
    label: { applicationId: choice === 'not_job' ? null : out.postingId, relevant: choice !== 'not_job', type: choice === 'not_job' ? 'other' : e.type, opportunity: choice === 'opportunity' },
    labeledAt: now.toISOString(),
  });
  return out;
}

export function saveEvalCase(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
