import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.ts';
import { storedKey } from '../agents/identity.ts';
import { insertEmail } from '../agents/inbox/store.ts';
import { loadKey, newKey, decrypt, encrypt } from '../agents/inbox/crypto.ts';
import { listNeedsReview, resolveReview, sealCaseLines } from '../agents/inbox/review.ts';
/** @import { EmailRecord } from '../agents/inbox/store.ts' */
/** @import { EmailsRow } from '../db/types.ts' */

// Synthetic data only.
const key = loadKey({ EMAIL_ENC_KEY: newKey() });
const now = new Date('2026-10-02T12:00:00Z');

async function setup() {
  const store = openJobStore(':memory:');
  const { db } = store;
  const add = async (/** @type {string} */ company, /** @type {string} */ title, /** @type {string} */ status) =>
    Number(
      (await db
        .prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at)
          VALUES (1, ?, ?, ?, ?, '2026-09-01', 'pipeline', ?, 'x', 'x') RETURNING id`)
        .run(`k${Math.random()}`, company, title, storedKey({ company, title }), status)).id,
    );
  const ids = { guess: await add('Example Co', 'VP of Engineering', 'applied'), other: await add('Sample Labs', 'CTO', 'applied') };
  const email = async (/** @type {Partial<EmailRecord>} */ o = {}) =>
    await insertEmail(db, {
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

const cases = (/** @type {string} */ path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('the review queue shows the best guess', async () => {
  const { store, db, ids, email } = await setup();
  await email();
  const [e] = await listNeedsReview(db);
  assert.equal(e.guess?.id, ids.guess);
  assert.equal(e.extracted.interview_times?.[0], 'October 8, 2026 10:00 AM');
  store.close();
});

test('confirm links the guess, runs the actions as the user, stores the body, and saves an eval case', async () => {
  const { store, db, ids, email, casesPath } = await setup();
  const id = await email();
  const r = await resolveReview(db, (await listNeedsReview(db))[0], 'confirm', { body: 'Can you talk on Oct 8?', key, now, casesPath });
  assert.deepEqual(r.statusChange, { from: 'applied', to: 'interviewing' });
  const row = /** @type {EmailsRow} */ (await db.prepare('SELECT * FROM emails WHERE id = ?').get(id));
  assert.deepEqual([row.review_status, row.posting_id, row.match_rule], ['confirmed', ids.guess, 'user']);
  assert.equal(decrypt(/** @type {string} */ (row.body_enc), key), 'Can you talk on Oct 8?');
  assert.equal(await db.prepare("SELECT decided_by FROM decision_log WHERE action = 'review:confirm'").pluck().get(), 'user');
  assert.equal(await db.prepare("SELECT decided_by FROM decision_log WHERE action = 'status_change'").pluck().get(), 'user');
  const [c] = cases(casesPath);
  assert.deepEqual(c.label, { applicationId: ids.guess, relevant: true, type: 'interview_request', opportunity: false });
  assert.ok(!readFileSync(casesPath, 'utf8').includes('Oct 8'), 'the case file never holds the email text in the clear');
  assert.equal(c.body, undefined);
  assert.equal(decrypt(c.bodyEnc, key), 'Can you talk on Oct 8?');
  assert.equal((await listNeedsReview(db)).length, 0);
  store.close();
});

test('reassign links a different application', async () => {
  const { store, db, ids, email, casesPath } = await setup();
  await email({ type: 'follow_up' });
  const r = await resolveReview(db, (await listNeedsReview(db))[0], 'reassign', { postingId: ids.other, now, casesPath });
  assert.equal(r.postingId, ids.other);
  assert.equal(await db.prepare('SELECT review_status FROM emails').pluck().get(), 'reassigned');
  assert.equal(cases(casesPath)[0].label.applicationId, ids.other);
  await assert.rejects(async () => await resolveReview(db, { ...(await listNeedsReview(db))[0] ?? { id: 'x', guess: null }, gmail_message_id: 'g' }, 'reassign', { postingId: 9999, now, casesPath }), /not found/);
  store.close();
});

test('not job related clears the link and labels the case irrelevant', async () => {
  const { store, db, email, casesPath } = await setup();
  await email();
  await resolveReview(db, (await listNeedsReview(db))[0], 'not_job', { body: 'A newsletter', key, now, casesPath });
  const row = await db.prepare('SELECT review_status, posting_id, body_enc FROM emails').get();
  assert.deepEqual(row, { review_status: 'not_job', posting_id: null, body_enc: null });
  assert.deepEqual(cases(casesPath)[0].label, { applicationId: null, relevant: false, type: 'other', opportunity: false });
  assert.equal(cases(casesPath)[0].bodyEnc, null, 'no text is kept for other mail, sealed or not');
  store.close();
});

test('sealing old cases: plain bodies become bodyEnc, not-job ones are dropped, sealed ones are left alone', () => {
  const sealed = encrypt('Already sealed', key);
  const old = [
    { gmailMessageId: 'a', subject: 'Next steps', body: 'Can we talk Friday?', label: { relevant: true } },
    { gmailMessageId: 'b', subject: 'Deals', body: 'Big sale today', label: { relevant: false } },
    { gmailMessageId: 'c', subject: 'Hi', body: null, label: { relevant: true } },
    { gmailMessageId: 'd', subject: 'Re: role', bodyEnc: sealed, label: { relevant: true } },
  ];
  const { text, counts } = sealCaseLines(`${old.map((r) => JSON.stringify(r)).join('\n')}\n`, key);
  assert.deepEqual(counts, { cases: 4, sealed: 1, dropped: 1 });
  assert.ok(!text.includes('Friday') && !text.includes('sale'), 'no email text left in the clear');
  const out = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(decrypt(out[0].bodyEnc, key), 'Can we talk Friday?');
  assert.deepEqual([out[1].bodyEnc, out[2].bodyEnc, out[3].bodyEnc], [null, null, sealed]);
  assert.ok(out.every((r) => !Object.hasOwn(r, 'body')));
  assert.equal(sealCaseLines(text, key).counts.sealed, 0, 'running it again changes nothing');
});

test('opportunity creates a discovered job from the email', async () => {
  const { store, db, email, casesPath } = await setup();
  await email({ type: 'recruiter_outreach', extracted: { company: 'Other Labs', role_title: 'Head of Engineering' } });
  const r = await resolveReview(db, (await listNeedsReview(db))[0], 'opportunity', { now, casesPath });
  assert.equal(await db.prepare('SELECT company FROM postings WHERE id = ?').pluck().get(r.postingId), 'Other Labs');
  assert.equal(await db.prepare('SELECT review_status FROM emails').pluck().get(), 'new_opportunity');
  assert.equal(cases(casesPath)[0].label.opportunity, true);
  store.close();
});

test('confirm without a guess explains what to do', async () => {
  const { store, db, email, casesPath } = await setup();
  await email({ extracted: {} });
  await assert.rejects(async () => await resolveReview(db, (await listNeedsReview(db))[0], 'confirm', { now, casesPath }), /reassign instead/);
  assert.equal(cases(casesPath).length, 0);
  store.close();
});

test('dismiss takes an unsure email off the list with no link, no status change, no body, and no eval case', async () => {
  const { store, db, ids, email, casesPath } = await setup();
  const id = await email();
  const r = await resolveReview(db, (await listNeedsReview(db))[0], 'dismiss', { body: 'Thanks for applying.', key, now, casesPath });
  assert.deepEqual([r.postingId, r.statusChange], [null, null]);
  const row = /** @type {Pick<EmailsRow, 'review_status' | 'posting_id' | 'body_enc'>} */ (await db.prepare('SELECT review_status, posting_id, body_enc FROM emails WHERE id = ?').get(id));
  assert.deepEqual([row.review_status, row.posting_id, row.body_enc], ['dismissed', null, null]);
  assert.equal(await db.prepare('SELECT status FROM postings WHERE id = ?').pluck().get(ids.guess), 'applied');
  assert.equal(await db.prepare("SELECT decided_by FROM decision_log WHERE action = 'review:dismiss'").pluck().get(), 'user');
  assert.deepEqual(cases(casesPath), [], 'no label when the user is not sure');
  assert.equal((await listNeedsReview(db)).length, 0);
  store.close();
});
