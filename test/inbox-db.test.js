import { asEngine } from '../db/engine/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openJobStore } from '../db/index.ts';
/** @import { Database } from '../tools/types.ts' */

const now = '2026-10-02T12:00:00.000Z';

/** @param {Database} db */
async function posting(db) {
  return Number(
    (await asEngine(db)
      .prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, discovered_on, status, created_at, updated_at)
        VALUES (1, 'https://jobs.example.com/1', 'jobs.example.com/1', 'Example Co', 'VP Engineering', 'example|vp', '2026-09-01', 'applied', ?, ?)`)
      .run(now, now)).id,
  );
}

/** @param {Database} db @param {Record<string, unknown>} [o] */
async function email(db, o = {}) {
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
  await asEngine(db).prepare(`INSERT INTO emails (user_id, id, gmail_message_id, thread_id, sender, sender_domain, sent_at, subject, type, posting_id, review_status, created_at, updated_at)
    VALUES (1, @id, @gmail_message_id, @thread_id, @sender, @sender_domain, @sent_at, @subject, @type, @posting_id, @review_status, '${now}', '${now}')`).run(row);
  return row;
}

test('007 adds the inbox tables and the company domain column; 013 drops its funnel view (a view cannot be per user)', async () => {
  const store = openJobStore(':memory:');
  const names = await asEngine(store.db).prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").pluck().all();
  for (const n of ['contacts', 'email_threads', 'emails', 'decision_log', 'reminders']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('application_funnel'), 'server/funnel.ts computes the funnel per user instead');
  assert.ok(/** @type {Array<{ name: string }>} */ (await asEngine(store.db).prepare('PRAGMA table_info(postings)').all()).some((c) => c.name === 'company_domain'));
  store.close();
});

test('emails are unique by Gmail message ID and only allow known types and review states', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const first = await email(db);
  await assert.rejects(async () => await email(db, { gmail_message_id: first.gmail_message_id }), /UNIQUE/);
  await assert.rejects(async () => await email(db, { type: 'spam' }), /CHECK/);
  await assert.rejects(async () => await email(db, { review_status: 'maybe' }), /CHECK/);
  store.close();
});

