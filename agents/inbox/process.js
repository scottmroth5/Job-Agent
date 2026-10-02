// One inbox run: find new (or backfill) messages, pre-filter, match, classify, act, label, and store.
// Skipped emails leave no trace. Bodies are stored, encrypted, only for emails linked to an application.
import { listOpenApplications, matchEmail } from './match.js';
import { prefilter } from './prefilter.js';
import { trimBody } from './atsParse.js';
import { classifyEmail, looksLikeInjection } from './classify.js';
import { decideLink, applyActions, createOpportunity } from './actions.js';
import { insertEmail, updateEmail, emailSeen, logDecision, isContact, isCompanyDomain, learnDomain } from './store.js';
import { encrypt } from './crypto.js';
import { makeEvent, createEmitter } from './events.js';
import { labelName } from './gmail.js';
import { newMessageIds, backfillMessageIds, saveCursor } from './sync.js';
import { getPrompt } from '../prompts.js';

// Rough Haiku 4.5 list prices for dry-run estimates: $1 / $5 per million input / output tokens.
const ESTIMATE = { fixedTokens: 900, perApplicationTokens: 15, outputTokens: 250, input: 1, output: 5 };

export function estimateCostUsd(emails, openCount) {
  return emails.reduce((usd, e) => {
    const input = ESTIMATE.fixedTokens + openCount * ESTIMATE.perApplicationTokens + (e.bodyChars ?? 2000) / 4;
    return usd + (input * ESTIMATE.input + ESTIMATE.outputTokens * ESTIMATE.output) / 1_000_000;
  }, 0);
}

const IGNORED_LABELS = ['SPAM', 'TRASH', 'CHAT', 'DRAFT'];

/**
 * Where a classified email goes: the rule cascade, then the confidence gate, then the injection guard
 * (an email with instructions aimed at an AI is held for review with no action, even when a rule links it,
 * because its type still comes from the model). Shared by the inbox run and the inbox eval.
 */
export function decideEmail(db, email, c, { cfg, open }) {
  const ruleMatch = matchEmail(db, email, { atsDomains: cfg.atsDomains, open });
  const link = decideLink({ ruleMatch, classification: c, threshold: cfg.autoLinkAt });
  if (!looksLikeInjection(email)) return link;
  return { ...link, postingId: null, opportunity: false, reviewStatus: 'needs_review', reason: 'contains instructions aimed at an AI; no action taken', bestGuess: link.postingId ?? link.bestGuess };
}

/**
 * @param {object} ctx
 * @param {{db, tx}} ctx.store
 * @param {object} ctx.gmail     createGmail()
 * @param {object} ctx.claude    agent-core createClaude()
 * @param {object} ctx.cfg       loadInboxConfig()
 * @param {Buffer} ctx.key       loadKey() (not needed for a dry run)
 * @param {object} [ctx.options] { mode: 'new' | 'backfill', days, dryRun }
 */
export async function runInbox({ store, gmail, claude, cfg, key, run, log = () => {}, now = () => new Date(), options = {} }) {
  const { db } = store;
  const { mode = 'new', days = cfg.backfillDays, dryRun = false } = options;
  const emitter = createEmitter();
  const prompt = getPrompt(db, 'inbox-classify');
  const summary = { mode, fetched: 0, alreadySeen: 0, skipped: 0, considered: 0, matched: 0, needsReview: 0, opportunities: 0, statusChanges: [], notices: [], labelErrors: 0, failures: [], dryRun };

  const batch = mode === 'backfill' ? await backfillMessageIds({ gmail, days }) : await newMessageIds({ gmail, db, fallbackDays: cfg.fallbackDays });
  summary.source = batch.mode;
  summary.fetched = batch.messageIds.length;
  log('info', `${batch.messageIds.length} messages to check (${batch.mode})`);
  const me = (await gmail.profile()).emailAddress;
  let open = listOpenApplications(db);
  const toClassify = [];

  for (const id of batch.messageIds) {
    if (emailSeen(db, id)) {
      summary.alreadySeen += 1;
      continue;
    }
    const msg = await gmail.getMessage(id);
    // My own messages and spam/trash/chats are never processed.
    if (msg.senderEmail === me || msg.labelIds.some((l) => l === 'SENT' || IGNORED_LABELS.includes(l))) {
      summary.skipped += 1;
      continue;
    }
    const checks = { isContact: isContact(db), isCompanyDomain: isCompanyDomain(db), atsDomains: cfg.atsDomains };
    let pass = prefilter(msg, { ...checks, threadStartedByMe: false });
    if (!pass.pass) pass = prefilter(msg, { ...checks, threadStartedByMe: await gmail.threadStartedByMe(msg.threadId) });
    if (!pass.pass) {
      summary.skipped += 1;
      continue;
    }
    summary.considered += 1;
    const email = { ...msg, body: trimBody(msg.rawBody, { html: msg.bodyIsHtml, max: cfg.bodyChars }) };
    if (dryRun) {
      toClassify.push({ bodyChars: email.body.length });
      continue;
    }

    let c;
    try {
      c = await classifyEmail(email, { claude, db, model: cfg.model, open, trace: run, prompt });
    } catch (err) {
      summary.failures.push({ id, error: `${err.name}: ${err.message}` });
      log('warn', `Classification failed for one message: ${err.name}`);
      continue;
    }
    const link = decideEmail(db, email, c, { cfg, open });
    const decidedBy = link.rule && link.rule !== 'model' ? `rule:${link.rule}` : `model:${c.model}`;
    const at = now();

    let company = null;
    store.tx(() => {
      const emailId = insertEmail(
        db,
        {
          ...email,
          type: c.type,
          postingId: link.postingId,
          matchRule: link.rule,
          confidence: link.confidence,
          reviewStatus: link.reviewStatus,
          reviewReason: link.reason,
          summary: c.summary,
          extracted: { ...c.extracted, ...(link.bestGuess ? { best_guess_application_id: link.bestGuess } : {}) },
          bodyEnc: link.postingId ? encrypt(email.body, key) : null,
          promptVersion: c.promptVersion,
          model: c.model,
        },
        at,
      );
      const row = { ...email, id: emailId };
      emitter.emit(makeEvent('email.received', { emailId }, at));

      if (link.postingId) {
        const r = applyActions(db, { email: row, postingId: link.postingId, c, decidedBy, promptVersion: c.promptVersion, now: at });
        learnDomain(db, link.postingId, email.senderDomain, cfg);
        company = db.prepare('SELECT company FROM postings WHERE id = ?').pluck().get(link.postingId);
        summary.matched += 1;
        if (r.statusChange) summary.statusChanges.push({ postingId: link.postingId, ...r.statusChange });
        summary.notices.push(...r.notices);
        emitter.emit(makeEvent('email.matched', { emailId, postingId: link.postingId, rule: link.rule }, at));
        if (r.review) {
          updateEmail(db, emailId, { reviewStatus: 'needs_review', reviewReason: r.review }, at);
          summary.needsReview += 1;
          emitter.emit(makeEvent('email.needs_review', { emailId, postingId: link.postingId }, at));
        }
      } else if (link.opportunity) {
        const postingId = createOpportunity(db, { email: row, c, decidedBy, promptVersion: c.promptVersion, now: at });
        updateEmail(db, emailId, { postingId, matchRule: 'model', bodyEnc: encrypt(email.body, key) }, at);
        company = c.extracted.company;
        summary.opportunities += 1;
        summary.notices.push(`New opportunity from a recruiter: ${c.extracted.role_title ?? 'a role'} at ${c.extracted.company ?? 'an unnamed company'}`);
        emitter.emit(makeEvent('email.matched', { emailId, postingId, rule: 'model' }, at));
      } else if (link.reviewStatus === 'needs_review') {
        logDecision(db, { emailId, gmailMessageId: email.gmailMessageId, action: 'needs_review', decidedBy, promptVersion: c.promptVersion, detail: { reason: link.reason, bestGuess: link.bestGuess, type: c.type } }, at);
        summary.needsReview += 1;
        emitter.emit(makeEvent('email.needs_review', { emailId }, at));
      }
    });
    if (company) {
      // Linked emails can also open new applications to match (an opportunity), so refresh the list.
      open = listOpenApplications(db);
      try {
        await gmail.addThreadLabel(email.threadId, await gmail.ensureLabel(labelName(company)));
      } catch (err) {
        summary.labelErrors += 1;
        log('warn', `Could not add a Gmail label: ${err.name}`);
      }
    }
  }

  if (dryRun) {
    summary.estimatedUsd = estimateCostUsd(toClassify, open.length);
  } else if (!summary.failures.length) {
    // On failures the cursor stays put, so the next run sees those messages again (stored ones are skipped).
    saveCursor(db, batch.nextHistoryId);
  }
  summary.events = emitter.counts();
  return summary;
}
