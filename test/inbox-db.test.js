import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openJobStore } from '../db/index.js';

const now = '2026-10-02T12:00:00.000Z';

function posting(db) {
  return Number(
    db
      .prepare(`INSERT INTO postings (url, url_key, company, title, company_title_key, discovered_on, status, created_at, updated_at)
        VALUES ('https://jobs.example.com/1', 'jobs.example.com/1', 'Example Co', 'VP Engineering', 'example|vp', '2026-09-01', 'applied', ?, ?)`)
      .run(now, now).lastInsertRowid,
  );
}

function email(db, o = {}) {
  const row = {
    id: randomUUID(),
    gmail_message_id: `m-${randomUUID()}`,
    thread_id: 't-1',
    sender: 'recruiting@example.com',
    sender_domain: 'example.com',
    sent_at: '2026-09-05T10:00:00Z',
    subject: 'Thanks for applying',
    type: 'confirmation',
    posting_id: null,
    review_status: 'auto',
    ...o,
  };
  db.prepare(`INSERT INTO emails (id, gmail_message_id, thread_id, sender, sender_domain, sent_at, subject, type, posting_id, review_status, created_at, updated_at)
    VALUES (@id, @gmail_message_id, @thread_id, @sender, @sender_domain, @sent_at, @subject, @type, @posting_id, @review_status, '${now}', '${now}')`).run(row);
  return row;
}

test('007 adds the inbox tables, the company domain column, and the funnel view', () => {
  const store = openJobStore(':memory:');
  const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").pluck().all();
  for (const n of ['contacts', 'email_threads', 'emails', 'decision_log', 'reminders', 'application_funnel']) assert.ok(names.includes(n), n);
  assert.ok(store.db.prepare('PRAGMA table_info(postings)').all().some((c) => c.name === 'company_domain'));
  store.close();
});

test('emails are unique by Gmail message ID and only allow known types and review states', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const first = email(db);
  assert.throws(() => email(db, { gmail_message_id: first.gmail_message_id }), /UNIQUE/);
  assert.throws(() => email(db, { type: 'spam' }), /CHECK/);
  assert.throws(() => email(db, { review_status: 'maybe' }), /CHECK/);
  store.close();
});

test('the funnel view reports dates from linked emails and ignores ones awaiting review', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const id = posting(db);
  email(db, { posting_id: id, type: 'confirmation', sent_at: '2026-09-05T10:00:00Z' });
  email(db, { posting_id: id, type: 'interview_request', sent_at: '2026-09-12T10:00:00Z' });
  email(db, { posting_id: id, type: 'offer', sent_at: '2026-09-20T10:00:00Z', review_status: 'needs_review' });
  const f = db.prepare('SELECT * FROM application_funnel WHERE posting_id = ?').get(id);
  assert.equal(f.received_at, '2026-09-05T10:00:00Z');
  assert.equal(f.first_response_at, '2026-09-05T10:00:00Z');
  assert.equal(f.interview_at, '2026-09-12T10:00:00Z');
  assert.equal(f.offer_at, null);
  store.close();
});
