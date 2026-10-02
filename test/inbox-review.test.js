import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.js';
import { storedKey } from '../agents/identity.js';
import { insertEmail } from '../agents/inbox/store.js';
import { loadKey, newKey, decrypt } from '../agents/inbox/crypto.js';
import { listNeedsReview, resolveReview } from '../agents/inbox/review.js';

// Synthetic data only.
const key = loadKey({ EMAIL_ENC_KEY: newKey() });
const now = new Date('2026-10-02T12:00:00Z');

function setup() {
  const store = openJobStore(':memory:');
  const { db } = store;
  const add = (company, title, status) =>
    Number(
      db
        .prepare(`INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '2026-09-01', 'pipeline', ?, 'x', 'x')`)
        .run(`k${Math.random()}`, company, title, storedKey({ company, title }), status).lastInsertRowid,
    );
  const ids = { guess: add('Example Co', 'VP of Engineering', 'applied'), other: add('Sample Labs', 'CTO', 'applied') };
  const email = (o) =>
    insertEmail(db, {
      gmailMessageId: `g${Math.random()}`,
      threadId: `t${Math.random()}`,
      senderEmail: 'no-reply@example.myworkdayjobs.com',
      senderDomain: 'example.myworkdayjobs.com',
      sentAt: '2026-10-01T10:00:00Z',
      subject: 'Next steps',
      type: 'interview_request',
      confidence: 0.6,
      reviewStatus: 'needs_review',
      reviewReason: 'low confidence (0.60)',
      summary: 'Invites a phone screen.',
      extracted: { interview_times: ['October 8, 2026 10:00 AM'], best_guess_application_id: ids.guess },
      promptVersion: 'pv1',
      ...o,
    }, now);
  const casesPath = join(mkdtempSync(join(tmpdir(), 'cases-')), 'review-cases.jsonl');
  return { store, db, ids, email, casesPath };
}

const cases = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('the review queue shows the best guess', () => {
  const { store, db, ids, email } = setup();
  email();
  const [e] = listNeedsReview(db);
  assert.equal(e.guess.id, ids.guess);
  assert.equal(e.extracted.interview_times[0], 'October 8, 2026 10:00 AM');
  store.close();
});

test('confirm links the guess, runs the actions as the user, stores the body, and saves an eval case', () => {
  const { store, db, ids, email, casesPath } = setup();
  const id = email();
  const r = resolveReview(db, listNeedsReview(db)[0], 'confirm', { body: 'Can you talk on Oct 8?', key, now, casesPath });
  assert.deepEqual(r.statusChange, { from: 'applied', to: 'interviewing' });
  const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
  assert.deepEqual([row.review_status, row.posting_id, row.match_rule], ['confirmed', ids.guess, 'user']);
  assert.equal(decrypt(row.body_enc, key), 'Can you talk on Oct 8?');
  assert.equal(db.prepare("SELECT decided_by FROM decision_log WHERE action = 'review:confirm'").pluck().get(), 'user');
  assert.equal(db.prepare("SELECT decided_by FROM decision_log WHERE action = 'status_change'").pluck().get(), 'user');
  const [c] = cases(casesPath);
  assert.deepEqual(c.label, { applicationId: ids.guess, relevant: true, type: 'interview_request', opportunity: false });
  assert.equal(listNeedsReview(db).length, 0);
  store.close();
});

test('reassign links a different application', () => {
  const { store, db, ids, email, casesPath } = setup();
  email({ type: 'follow_up' });
  const r = resolveReview(db, listNeedsReview(db)[0], 'reassign', { postingId: ids.other, now, casesPath });
  assert.equal(r.postingId, ids.other);
  assert.equal(db.prepare('SELECT review_status FROM emails').pluck().get(), 'reassigned');
  assert.equal(cases(casesPath)[0].label.applicationId, ids.other);
  assert.throws(() => resolveReview(db, { ...listNeedsReview(db)[0] ?? { id: 'x', guess: null }, gmail_message_id: 'g' }, 'reassign', { postingId: 9999, now, casesPath }), /not found/);
  store.close();
});

test('not job related clears the link and labels the case irrelevant', () => {
  const { store, db, email, casesPath } = setup();
  email();
  resolveReview(db, listNeedsReview(db)[0], 'not_job', { now, casesPath });
  const row = db.prepare('SELECT review_status, posting_id, body_enc FROM emails').get();
  assert.deepEqual(row, { review_status: 'not_job', posting_id: null, body_enc: null });
  assert.deepEqual(cases(casesPath)[0].label, { applicationId: null, relevant: false, type: 'other', opportunity: false });
  store.close();
});

test('opportunity creates a discovered job from the email', () => {
  const { store, db, email, casesPath } = setup();
  email({ type: 'recruiter_outreach', extracted: { company: 'Other Labs', role_title: 'Head of Engineering' } });
  const r = resolveReview(db, listNeedsReview(db)[0], 'opportunity', { now, casesPath });
  assert.equal(db.prepare('SELECT company FROM postings WHERE id = ?').pluck().get(r.postingId), 'Other Labs');
  assert.equal(db.prepare('SELECT review_status FROM emails').pluck().get(), 'new_opportunity');
  assert.equal(cases(casesPath)[0].label.opportunity, true);
  store.close();
});

test('confirm without a guess explains what to do', () => {
  const { store, db, email, casesPath } = setup();
  email({ extracted: {} });
  assert.throws(() => resolveReview(db, listNeedsReview(db)[0], 'confirm', { now, casesPath }), /reassign instead/);
  assert.equal(cases(casesPath).length, 0);
  store.close();
});
