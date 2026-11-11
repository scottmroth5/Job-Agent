// Runs the inbox's real decision code (pre-filter, rule cascade, Claude classification, confidence gate,
// injection guard) over synthetic labeled emails. Each case gets a fresh in-memory database.
import { asEngine } from '../../db/engine/index.ts';
import { openJobStore } from '../../db/index.ts';
import { storedKey } from '../../agents/identity.ts';
import { prefilter, domainOf } from '../../agents/inbox/prefilter.ts';
import { trimBody } from '../../agents/inbox/atsParse.ts';
import { classifyEmail } from '../../agents/inbox/classify.ts';
import { listOpenApplications } from '../../agents/inbox/match.ts';
import { decideEmail, estimateCostUsd } from '../../agents/inbox/process.ts';
import { parseFrom } from '../../agents/inbox/gmail.ts';
import { isContact, isCompanyDomain } from '../../agents/inbox/store.ts';
/**
 * @import { Claude, Run } from '@scottmroth5/agent-core'
 * @import { Database } from '../../tools/types.ts'
 * @import { InboxConfig } from '../../agents/inbox/config.ts'
 * @import { InboxResult } from './metrics.js'
 */

/**
 * evals/inbox/cases.json: the open applications, and labeled emails.
 * @typedef {{ id: number, company: string, title: string, status: string, domain?: string }} EvalApplication
 * @typedef {{ from: string, subject: string, body: string, sentAt?: string, threadStartedByMe?: boolean }} EvalEmail
 * @typedef {{ id: string, email: EvalEmail, expected: InboxResult['expected'] }} InboxCase
 */

/**
 * @param {Database} db
 * @param {EvalApplication[]} applications
 */
async function seed(db, applications) {
  const insert = asEngine(db).prepare(`INSERT INTO postings (user_id, id, url_key, company, title, company_title_key, discovered_on, stage, status, company_domain, created_at, updated_at)
    VALUES (@uid, ?, ?, ?, ?, ?, '2026-09-01', 'pipeline', ?, ?, 'x', 'x')`);
  for (const a of applications) await insert.run(a.id, `eval-${a.id}`, a.company, a.title, storedKey(a), a.status, a.domain ?? null);
}

/**
 * @param {InboxCase} c
 * @param {number} bodyChars
 */
export function toEmail(c, bodyChars) {
  const from = parseFrom(c.email.from);
  return {
    gmailMessageId: c.id,
    threadId: `thread-${c.id}`,
    senderName: from.name,
    senderEmail: from.email,
    senderDomain: domainOf(from.email),
    subject: c.email.subject,
    sentAt: c.email.sentAt ?? '2026-10-01T15:00:00Z',
    body: trimBody(c.email.body, { max: bodyChars }),
  };
}

/**
 * @param {InboxCase[]} cases
 * @param {EvalApplication[]} applications
 * @param {number} bodyChars
 */
export const estimateInboxEval = (cases, applications, bodyChars) => estimateCostUsd(cases.map((c) => ({ bodyChars: Math.min(c.email.body.length, bodyChars) })), applications.length);

/**
 * @param {{ cases: InboxCase[], applications: EvalApplication[], claude: Claude, cfg: InboxConfig, model?: string, trace?: Run | null, log?: (line: string) => void }} opts
 * @returns {Promise<InboxResult[]>} one result per case, for inboxMetrics()
 */
export async function runInboxEval({ cases, applications, claude, cfg, model = cfg.model, trace, log = () => {} }) {
  /** @type {InboxResult[]} */
  const results = [];
  for (const c of cases) {
    const store = openJobStore(':memory:');
    try {
      const { db } = store;
      await seed(db, applications);
      const email = toEmail(c, cfg.bodyChars);
      const pass = prefilter(email, { threadStartedByMe: Boolean(c.email.threadStartedByMe), isContact: await isContact(db), isCompanyDomain: await isCompanyDomain(db), atsDomains: cfg.atsDomains });
      if (!pass.pass) {
        results.push({ id: c.id, expected: c.expected, passed: false, predicted: null, rule: null });
        continue;
      }
      const open = await listOpenApplications(db);
      const cls = await classifyEmail(email, { claude, db, model, open, trace });
      const link = await decideEmail(db, email, cls, { cfg, open });
      results.push({
        id: c.id,
        expected: c.expected,
        passed: true,
        predicted: { applicationId: link.postingId, type: cls.type, reviewStatus: link.reviewStatus, modelGuess: cls.applicationId, confidence: cls.confidence },
        rule: link.rule,
      });
      log(`${c.id}: ${cls.type}${link.postingId ? ` -> #${link.postingId}` : ''}${link.reviewStatus === 'needs_review' ? ' (review)' : ''}`);
    } finally {
      store.close();
    }
  }
  return results;
}
