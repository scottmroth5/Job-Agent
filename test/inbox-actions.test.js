import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { storedKey } from '../agents/identity.ts';
import { decideLink, planStatus, applyActions, createOpportunity, parseDeadline } from '../agents/inbox/actions.ts';
import { insertEmail, learnDomain, isCompanyDomain } from '../agents/inbox/store.ts';
import { loadInboxConfig } from '../agents/inbox/config.ts';
/** @import { Classification } from '../agents/inbox/classify.ts' */
/** @import { Db } from '../tools/types.ts' */
/** @typedef {{ id: string, gmailMessageId: string, threadId: string, senderEmail: string, senderDomain: string, sentAt: string, subject: string }} Email */

// Synthetic data only.
const cfg = loadInboxConfig();
const now = new Date('2026-10-02T12:00:00Z');
/** A classification with the fields a test sets. @param {Partial<Omit<Classification, 'extracted'>> & { extracted?: Partial<Classification['extracted']> }} [o] */
const c = (o = {}) => /** @type {Classification} */ ({
  applicationId: null,
  confidence: 0.9,
  type: 'other',
  extracted: { company: null, role_title: null, contact_name: null, contact_email: null, interview_times: [], deadline: null, ...(o.extracted ?? {}) },
  summary: 'A short summary.',
  ...o,
  ...(o.extracted ? { extracted: { company: null, role_title: null, contact_name: null, contact_email: null, interview_times: [], deadline: null, ...o.extracted } } : {}),
});

async function setup(status = 'applied') {
  const store = openJobStore(':memory:');
  const { db } = store;
  const postingId = Number(
    (await db
      .prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at)
        VALUES (1, 'k1', 'Example Co', 'VP of Engineering', ?, '2026-09-01', 'pipeline', ?, 'x', 'x')`)
      .run(storedKey({ company: 'Example Co', title: 'VP of Engineering' }), status)).id,
  );
  const fields = { gmailMessageId: 'g1', threadId: 't1', senderEmail: 'pat.recruiter@example.com', senderDomain: 'example.com', sentAt: '2026-09-30T14:00:00Z', subject: 's' };
  /** @type {Email} */
  const email = { ...fields, id: await insertEmail(db, { ...fields, reviewStatus: 'auto' }, now) };
  return { store, db, postingId, email };
}

/** @param {Db} db @param {number} postingId @param {Email} email @param {Classification} cls */
const act = async (db, postingId, email, cls) => await applyActions(db, { email, postingId, c: cls, decidedBy: 'rule:thread', promptVersion: 'pv1', now });
const status = async (/** @type {Db} */ db, /** @type {number} */ id) => /** @type {{ status: string, applied_on: string | null }} */ (await db.prepare('SELECT status, applied_on FROM postings WHERE id = ?').get(id));

test('the confidence gate: rule matches are certain, 0.85 links, 0.84 goes to review', () => {
  assert.deepEqual(decideLink({ ruleMatch: { postingId: 5, rule: 'thread' }, classification: c({ confidence: 0.1 }), threshold: 0.85 }).confidence, 1);
  const at = decideLink({ classification: c({ applicationId: 5, confidence: 0.85 }), threshold: 0.85 });
  assert.deepEqual([at.postingId, at.rule, at.reviewStatus], [5, 'model', 'auto']);
  const below = decideLink({ classification: c({ applicationId: 5, confidence: 0.84 }), threshold: 0.85 });
  assert.deepEqual([below.postingId, below.reviewStatus, below.bestGuess], [null, 'needs_review', 5]);
});

test('unmatched emails: outreach becomes an opportunity, application news needs review, other mail is just recorded', () => {
  assert.equal(decideLink({ classification: c({ type: 'recruiter_outreach', confidence: 0.9 }), threshold: 0.85 }).opportunity, true);
  assert.equal(decideLink({ classification: c({ type: 'recruiter_outreach', confidence: 0.5 }), threshold: 0.85 }).reviewStatus, 'needs_review');
  assert.equal(decideLink({ classification: c({ type: 'rejection' }), threshold: 0.85 }).reviewStatus, 'needs_review');
  const other = decideLink({ classification: c({ type: 'other' }), threshold: 0.85 });
  assert.deepEqual([other.reviewStatus, other.opportunity, other.postingId], ['auto', false, null]);
});

test('status mapping for each email type', () => {
  assert.deepEqual(planStatus('new', 'confirmation'), { change: { from: 'new', to: 'applied' } });
  assert.deepEqual(planStatus('applied', 'rejection'), { change: { from: 'applied', to: 'rejected' } });
  assert.deepEqual(planStatus('applied', 'interview_request'), { change: { from: 'applied', to: 'interviewing' } });
  assert.deepEqual(planStatus('interviewing', 'offer'), { change: { from: 'interviewing', to: 'offer' } });
  for (const t of ['assessment', 'follow_up', 'recruiter_outreach', 'other']) assert.deepEqual(planStatus('applied', t), { none: true }, t);
  assert.deepEqual(planStatus('applied', 'confirmation'), { none: true });
});

test('status never moves backward or reopens a closed application automatically', () => {
  const review = (/** @type {string} */ from, /** @type {string} */ type) => /** @type {string} */ (planStatus(from, type).review);
  assert.match(review('offer', 'rejection'), /after an offer/);
  assert.match(review('rejected', 'interview_request'), /reopen/);
  assert.match(review('passed', 'confirmation'), /reopen/);
  assert.match(review('interviewing', 'confirmation'), /backward/);
  assert.match(review('offer', 'interview_request'), /backward/);
});

test('a confirmation moves new to applied with the email date, and logs the decision', async () => {
  const { store, db, postingId, email } = await setup('new');
  const r = await act(db, postingId, email, c({ type: 'confirmation' }));
  assert.deepEqual(r.statusChange, { from: 'new', to: 'applied' });
  assert.deepEqual(await status(db, postingId), { status: 'applied', applied_on: '2026-09-30' });
  const log = /** @type {Record<string, unknown>} */ (await db.prepare("SELECT * FROM decision_log WHERE action = 'status_change'").get());
  assert.deepEqual([log.gmail_message_id, log.decided_by, log.prompt_version, log.from_status, log.to_status], ['g1', 'rule:thread', 'pv1', 'new', 'applied']);
  assert.equal(await db.prepare('SELECT changed_by FROM status_history WHERE posting_id = ?').pluck().get(postingId), 'agent');
  assert.equal(await db.prepare('SELECT posting_id FROM email_threads WHERE thread_id = ?').pluck().get('t1'), postingId);
  assert.equal(await db.prepare('SELECT posting_id FROM contacts WHERE email = ?').pluck().get('pat.recruiter@example.com'), postingId);
  store.close();
});

test('a rejection after an offer changes nothing and asks for review', async () => {
  const { store, db, postingId, email } = await setup('offer');
  const r = await act(db, postingId, email, c({ type: 'rejection' }));
  assert.equal(r.statusChange, null);
  assert.match(/** @type {string} */ (r.review), /after an offer/);
  assert.equal((await status(db, postingId)).status, 'offer');
  assert.equal(await db.prepare("SELECT COUNT(*) FROM decision_log WHERE action = 'needs_review'").pluck().get(), 1);
  store.close();
});

test('an interview request stores the times and contact and prints a notice', async () => {
  const { store, db, postingId, email } = await setup();
  const r = await act(db, postingId, email, c({ type: 'interview_request', extracted: { contact_name: 'Pat Example', contact_email: 'pat@example.com', interview_times: ['October 8, 2026 2:00 PM ET'] } }));
  assert.equal((await status(db, postingId)).status, 'interviewing');
  assert.match(r.notices[0], /^INTERVIEW REQUEST: VP of Engineering at Example Co \(proposed: October 8, 2026 2:00 PM ET\), from Pat Example$/);
  const rem = await db.prepare('SELECT kind, note FROM reminders').get();
  assert.deepEqual(rem, { kind: 'interview', note: 'Proposed: October 8, 2026 2:00 PM ET' });
  assert.equal(await db.prepare('SELECT name FROM contacts WHERE email = ?').pluck().get('pat@example.com'), 'Pat Example');
  store.close();
});

test('an assessment creates a reminder with its deadline; an offer prints a notice', async () => {
  const { store, db, postingId, email } = await setup('interviewing');
  const a = await act(db, postingId, email, c({ type: 'assessment', extracted: { deadline: 'October 9, 2026' } }));
  assert.equal((await status(db, postingId)).status, 'interviewing');
  assert.equal(/** @type {string} */ (await db.prepare('SELECT due_at FROM reminders WHERE id = ?').pluck().get(a.reminderId)).slice(0, 10), '2026-10-09');
  const o = await act(db, postingId, { ...email, gmailMessageId: 'g2' }, c({ type: 'offer' }));
  assert.deepEqual(o.notices, ['OFFER: VP of Engineering at Example Co']);
  assert.equal(parseDeadline('next week sometime'), null);
  store.close();
});

test('unmatched recruiter outreach creates a discovered opportunity without copying the body', async () => {
  const { store, db, email } = await setup();
  const id = await createOpportunity(db, { email: { ...email, threadId: 't9' }, c: c({ type: 'recruiter_outreach', summary: 'A recruiter asks about a CTO role.', extracted: { company: 'Sample Labs', role_title: 'CTO' } }), decidedBy: 'model:m', promptVersion: 'pv1', now });
  const p = /** @type {Record<string, string | null>} */ (await db.prepare('SELECT company, title, source, stage, status, notes, jd_text FROM postings WHERE id = ?').get(id));
  assert.deepEqual([p.company, p.title, p.source, p.stage, p.status, p.jd_text], ['Sample Labs', 'CTO', 'email', 'discovered', 'new', null]);
  assert.match(/** @type {string} */ (p.notes), /#all\/t9/);
  assert.equal(await db.prepare("SELECT kind FROM email_threads WHERE thread_id = 't9'").pluck().get(), 'outreach');
  store.close();
});

test('company domains are learned from employer mail only', async () => {
  const { store, db, postingId } = await setup();
  assert.equal(await learnDomain(db, postingId, 'us.greenhouse.io', cfg), false);
  assert.equal(await learnDomain(db, postingId, 'gmail.com', cfg), false);
  assert.equal(await learnDomain(db, postingId, 'example.com', cfg), true);
  assert.ok((await isCompanyDomain(db))('talent.example.com'));
  store.close();
});
