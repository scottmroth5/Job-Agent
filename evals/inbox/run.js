// Runs the inbox's real decision code (pre-filter, rule cascade, Claude classification, confidence gate,
// injection guard) over synthetic labeled emails. Each case gets a fresh in-memory database.
import { openJobStore } from '../../db/index.js';
import { storedKey } from '../../agents/identity.js';
import { prefilter, domainOf } from '../../agents/inbox/prefilter.js';
import { trimBody } from '../../agents/inbox/atsParse.js';
import { classifyEmail } from '../../agents/inbox/classify.js';
import { listOpenApplications } from '../../agents/inbox/match.js';
import { decideEmail, estimateCostUsd } from '../../agents/inbox/process.js';
import { parseFrom } from '../../agents/inbox/gmail.js';
import { isContact, isCompanyDomain } from '../../agents/inbox/store.js';

function seed(db, applications) {
  const insert = db.prepare(`INSERT INTO postings (id, url_key, company, title, company_title_key, discovered_on, stage, status, company_domain, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '2026-09-01', 'pipeline', ?, ?, 'x', 'x')`);
  for (const a of applications) insert.run(a.id, `eval-${a.id}`, a.company, a.title, storedKey(a), a.status, a.domain ?? null);
}

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

export const estimateInboxEval = (cases, applications, bodyChars) => estimateCostUsd(cases.map((c) => ({ bodyChars: Math.min(c.email.body.length, bodyChars) })), applications.length);

/** @returns {Promise<object[]>} one result per case, for inboxMetrics() */
export async function runInboxEval({ cases, applications, claude, cfg, model = cfg.model, trace, log = () => {} }) {
  const results = [];
  for (const c of cases) {
    const store = openJobStore(':memory:');
    try {
      const { db } = store;
      seed(db, applications);
      const email = toEmail(c, cfg.bodyChars);
      const pass = prefilter(email, { threadStartedByMe: Boolean(c.email.threadStartedByMe), isContact: isContact(db), isCompanyDomain: isCompanyDomain(db), atsDomains: cfg.atsDomains });
      if (!pass.pass) {
        results.push({ id: c.id, expected: c.expected, passed: false, predicted: null, rule: null });
        continue;
      }
      const open = listOpenApplications(db);
      const cls = await classifyEmail(email, { claude, db, model, open, trace });
      const link = decideEmail(db, email, cls, { cfg, open });
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
