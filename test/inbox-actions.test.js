import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { storedKey } from '../agents/identity.js';
import { decideLink, planStatus, applyActions, createOpportunity, parseDeadline } from '../agents/inbox/actions.js';
import { insertEmail, learnDomain, isCompanyDomain } from '../agents/inbox/store.js';
import { loadInboxConfig } from '../agents/inbox/config.js';

// Synthetic data only.
const cfg = loadInboxConfig();
const now = new Date('2026-10-02T12:00:00Z');
const c = (o = {}) => ({
  applicationId: null,
  confidence: 0.9,
  type: 'other',
  extracted: { company: null, role_title: null, contact_name: null, contact_email: null, interview_times: [], deadline: null, ...(o.extracted ?? {}) },
  summary: 'A short summary.',
  ...o,
  ...(o.extracted ? { extracted: { company: null, role_title: null, contact_name: null, contact_email: null, interview_times: [], deadline: null, ...o.extracted } } : {}),
});

function setup(status = 'applied') {
  const store = openJobStore(':memory:');
  const { db } = store;
  const postingId = Number(
    db
      .prepare(`INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at)
        VALUES ('k1', 'Example Co', 'VP of Engineering', ?, '2026-09-01', 'pipeline', ?, 'x', 'x')`)
      .run(storedKey({ company: 'Example Co', title: 'VP of Engineering' }), status).lastInsertRowid,
  );
  const email = { gmailMessageId: 'g1', threadId: 't1', senderEmail: 'pat.recruiter@example.com', senderDomain: 'example.com', sentAt: '2026-09-30T14:00:00Z', subject: 's' };
  email.id = insertEmail(db, { ...email, reviewStatus: 'auto' }, now);
  return { store, db, postingId, email };
}

const act = (db, postingId, email, cls) => applyActions(db, { email, postingId, c: cls, decidedBy: 'rule:thread', promptVersion: 'pv1', now });
const status = (db, id) => db.prepare('SELECT status, applied_on FROM postings WHERE id = ?').get(id);

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
  assert.match(planStatus('offer', 'rejection').review, /after an offer/);
  assert.match(planStatus('rejected', 'interview_request').review, /reopen/);
  assert.match(planStatus('passed', 'confirmation').review, /reopen/);
  assert.match(planStatus('interviewing', 'confirmation').review, /backward/);
  assert.match(planStatus('offer', 'interview_request').review, /backward/);
});

test('a confirmation moves new to applied with the email date, and logs the decision', () => {
  const { store, db, postingId, email } = setup('new');
  const r = act(db, postingId, email, c({ type: 'confirmation' }));
  assert.deepEqual(r.statusChange, { from: 'new', to: 'applied' });
  assert.deepEqual(status(db, postingId), { status: 'applied', applied_on: '2026-09-30' });
  const log = db.prepare("SELECT * FROM decision_log WHERE action = 'status_change'").get();
  assert.deepEqual([log.gmail_message_id, log.decided_by, log.prompt_version, log.from_status, log.to_status], ['g1', 'rule:thread', 'pv1', 'new', 'applied']);
  assert.equal(db.prepare('SELECT changed_by FROM status_history WHERE posting_id = ?').pluck().get(postingId), 'agent');
  assert.equal(db.prepare('SELECT posting_id FROM email_threads WHERE thread_id = ?').pluck().get('t1'), postingId);
  assert.equal(db.prepare('SELECT posting_id FROM contacts WHERE email = ?').pluck().get('pat.recruiter@example.com'), postingId);
  store.close();
});

test('a rejection after an offer changes nothing and asks for review', () => {
  const { store, db, postingId, email } = setup('offer');
  const r = act(db, postingId, email, c({ type: 'rejection' }));
  assert.equal(r.statusChange, null);
  assert.match(r.review, /after an offer/);
  assert.equal(status(db, postingId).status, 'offer');
  assert.equal(db.prepare("SELECT COUNT(*) FROM decision_log WHERE action = 'needs_review'").pluck().get(), 1);
  store.close();
});

test('an interview request stores the times and contact and prints a notice', () => {
  const { store, db, postingId, email } = setup();
  const r = act(db, postingId, email, c({ type: 'interview_request', extracted: { contact_name: 'Pat Example', contact_email: 'pat@example.com', interview_times: ['October 8, 2026 2:00 PM ET'] } }));
  assert.equal(status(db, postingId).status, 'interviewing');
  assert.match(r.notices[0], /^INTERVIEW REQUEST: VP of Engineering at Example Co \(proposed: October 8, 2026 2:00 PM ET\), from Pat Example$/);
  const rem = db.prepare('SELECT kind, note FROM reminders').get();
  assert.deepEqual(rem, { kind: 'interview', note: 'Proposed: October 8, 2026 2:00 PM ET' });
  assert.equal(db.prepare('SELECT name FROM contacts WHERE email = ?').pluck().get('pat@example.com'), 'Pat Example');
  store.close();
});

test('an assessment creates a reminder with its deadline; an offer prints a notice', () => {
  const { store, db, postingId, email } = setup('interviewing');
  const a = act(db, postingId, email, c({ type: 'assessment', extracted: { deadline: 'October 9, 2026' } }));
  assert.equal(status(db, postingId).status, 'interviewing');
  assert.equal(db.prepare('SELECT due_at FROM reminders WHERE id = ?').pluck().get(a.reminderId).slice(0, 10), '2026-10-09');
  const o = act(db, postingId, { ...email, gmailMessageId: 'g2' }, c({ type: 'offer' }));
  assert.deepEqual(o.notices, ['OFFER: VP of Engineering at Example Co']);
  assert.equal(parseDeadline('next week sometime'), null);
  store.close();
});

test('unmatched recruiter outreach creates a discovered opportunity without copying the body', () => {
  const { store, db, email } = setup();
  const id = createOpportunity(db, { email: { ...email, threadId: 't9' }, c: c({ type: 'recruiter_outreach', summary: 'A recruiter asks about a CTO role.', extracted: { company: 'Sample Labs', role_title: 'CTO' } }), decidedBy: 'model:m', promptVersion: 'pv1', now });
  const p = db.prepare('SELECT company, title, source, stage, status, notes, jd_text FROM postings WHERE id = ?').get(id);
  assert.deepEqual([p.company, p.title, p.source, p.stage, p.status, p.jd_text], ['Sample Labs', 'CTO', 'email', 'discovered', 'new', null]);
  assert.match(p.notes, /#all\/t9/);
  assert.equal(db.prepare("SELECT kind FROM email_threads WHERE thread_id = 't9'").pluck().get(), 'outreach');
  store.close();
});

test('company domains are learned from employer mail only', () => {
  const { store, db, postingId } = setup();
  assert.equal(learnDomain(db, postingId, 'us.greenhouse.io', cfg), false);
  assert.equal(learnDomain(db, postingId, 'gmail.com', cfg), false);
  assert.equal(learnDomain(db, postingId, 'example.com', cfg), true);
  assert.ok(isCompanyDomain(db)('talent.example.com'));
  store.close();
});
