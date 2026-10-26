// Migration 013 (multi-user, phase 1) on a database that already has a job search: every row becomes the owner's,
// nothing is lost or unlinked, keys become unique per user, and user_id is required. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@scottmroth5/agent-core';
import { loadMigrations, openJobStore } from '../db/index.js';
import { USER_TABLES } from '../db/migrations/013-users.js';
import { runAsUser, scopeDb } from '../db/scope.js';
import { addUser, OWNER_ID, userForEmail } from '../db/users.js';

function before013(path) {
  const store = openStore(path, { app: 'job-agent', migrations: loadMigrations().filter((m) => m.id < '013') });
  const { db } = store;
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const job = (key) => Number(run(`INSERT INTO postings (url, url_key, company, title, company_title_key, discovered_on, stage, status, notes, created_at, updated_at)
    VALUES (?, ?, 'Example Co', 'CTO', ?, '2026-10-01', 'pipeline', 'applied', 'A note', 'x', 'x')`, `https://jobs.example.com/${key}`, key, `example|cto|${key}`).lastInsertRowid);
  const a = job('a');
  const b = job('b');
  run("INSERT INTO scores (posting_id, score, source, created_at) VALUES (?, 8, 'v2', 'x')", a);
  run("INSERT INTO artifacts (posting_id, kind, content, source, created_at) VALUES (?, 'cover_letter', 'Body', 'v2', 'x')", a);
  run("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, 'new', 'applied', 'user', 'x')", a);
  run("INSERT INTO posting_notes (id, posting_id, body, source, created_at, updated_at) VALUES ('n1', ?, 'A note', 'earlier', 'x', 'x')", a);
  run("INSERT INTO posting_sightings (posting_id, source, url, seen_on) VALUES (?, 'linkedin', 'https://jobs.example.com/a', 'x')", a);
  run("INSERT INTO attachments (id, posting_id, filename, content_type, size_bytes, sha256, created_at) VALUES ('f1', ?, 'r.pdf', 'application/pdf', 1, 'h', 'x')", a);
  run("INSERT INTO meeting_preps (id, posting_id, attendees_json, content, model, created_at) VALUES ('m1', ?, '[]', 'Prep', 'model', 'x')", a);
  run("INSERT INTO email_threads (thread_id, posting_id, kind, created_at) VALUES ('t1', ?, 'application', 'x')", a);
  run(`INSERT INTO emails (id, gmail_message_id, thread_id, sender, sender_domain, sent_at, type, posting_id, review_status, created_at, updated_at)
    VALUES ('e1', 'g1', 't1', 'hr@example.com', 'example.com', 'x', 'confirmation', ?, 'auto', 'x', 'x')`, a);
  run("INSERT INTO contacts (id, email, posting_id, source, created_at, updated_at) VALUES ('c1', 'hr@example.com', ?, 'email', 'x', 'x')", a);
  run("INSERT INTO reminders (id, posting_id, email_id, kind, created_at) VALUES ('r1', ?, 'e1', 'assessment', 'x')", a);
  run("INSERT INTO decision_log (id, posting_id, email_id, action, decided_by, created_at) VALUES ('d1', ?, 'e1', 'link', 'rule', 'x')", a);
  run("INSERT INTO prompt_versions (name, template, active, created_at) VALUES ('score', 'Edited {{candidateName}}', 1, 'x')");
  for (const [k, v] of [['inbox.historyId', '500'], ['drive.coverLetterFolderId', 'folder-1'], ['layout:home', '["inbox"]'], ['claude.monthlyBudgetUsd', '40']]) {
    run('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)', k, v, 'x');
  }
  store.close();
  return { a, b };
}

test('013 gives every row to the owner, keeps every link, and moves personal settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm013-'));
  try {
    const path = join(dir, 'job-agent.db');
    const { a, b } = before013(path);
    const store = openJobStore(path, { log: {} });
    const raw = store.raw;
    for (const t of USER_TABLES) {
      const rows = raw.prepare(`SELECT user_id FROM "${t}"`).pluck().all();
      assert.ok(rows.length > 0, `${t} has rows`);
      assert.ok(rows.every((u) => u === OWNER_ID), `${t} rows are the owner's`);
    }
    assert.equal(raw.prepare('SELECT COUNT(*) FROM postings').pluck().get(), 2);
    for (const t of ['scores', 'artifacts', 'status_history', 'posting_notes', 'posting_sightings', 'attachments', 'meeting_preps', 'email_threads', 'emails', 'contacts', 'reminders', 'decision_log']) {
      assert.equal(raw.prepare(`SELECT COUNT(*) FROM ${t} WHERE posting_id = ?`).pluck().get(a), 1, `${t} still points at the job`);
    }
    assert.deepEqual(raw.pragma('foreign_key_check'), []);
    assert.equal(raw.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(raw.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(raw.prepare('SELECT key FROM user_settings ORDER BY key').pluck().all(), ['drive.coverLetterFolderId', 'inbox.historyId', 'layout:home']);
    assert.deepEqual(raw.prepare('SELECT key FROM app_settings').pluck().all(), ['claude.monthlyBudgetUsd'], 'app-wide settings stay');
    assert.equal(raw.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'application_funnel'").pluck().get(), 0);
    assert.equal(raw.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'postings'").pluck().get(), 2, 'the list checks are back');
    assert.throws(() => raw.prepare("UPDATE postings SET status = 'maybe' WHERE id = ?").run(a), /status is not in the status list/);
    assert.deepEqual(raw.prepare("SELECT role, status FROM users WHERE id = ?").get(OWNER_ID), { role: 'admin', status: 'active' });

    // Cascades still reach the rebuilt children.
    raw.prepare('DELETE FROM postings WHERE id = ?').run(b);
    raw.prepare('DELETE FROM postings WHERE id = ?').run(a);
    assert.equal(raw.prepare('SELECT COUNT(*) FROM scores').pluck().get(), 0);
    assert.equal(raw.prepare('SELECT COUNT(*) FROM emails WHERE posting_id IS NOT NULL').pluck().get(), 0, 'emails are unlinked, not deleted');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keys are unique per user, and user_id is required', () => {
  const store = openJobStore(':memory:');
  const raw = store.raw;
  const second = addUser(raw, { email: 'second@example.com' });
  const job = (uid, key) => raw.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
    VALUES (?, ?, 'Example Co', 'CTO', 'k', '2026-10-01', 'x', 'x')`).run(uid, key);
  job(OWNER_ID, 'same');
  job(second, 'same');
  assert.throws(() => job(OWNER_ID, 'same'), /UNIQUE/);
  assert.throws(() => raw.prepare("INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, created_at, updated_at) VALUES ('x', 'C', 'T', 'k', 'd', 'x', 'x')").run(), /NOT NULL constraint failed: postings.user_id/);
  assert.throws(() => job(99, 'ghost'), /FOREIGN KEY/);
  const contact = (uid) => raw.prepare("INSERT INTO contacts (user_id, id, email, source, created_at, updated_at) VALUES (?, ?, 'hr@example.com', 'email', 'x', 'x')").run(uid, `c${uid}`);
  contact(OWNER_ID);
  contact(second);
  assert.throws(() => raw.prepare("INSERT INTO contacts (user_id, id, email, source, created_at, updated_at) VALUES (?, 'c9', 'hr@example.com', 'email', 'x', 'x')").run(OWNER_ID), /UNIQUE/);
  store.close();
});

test('scopeDb binds the current user, and a user-table query with no user throws', () => {
  const store = openJobStore(':memory:', { fallbackUid: null });
  const second = addUser(store.raw, { email: 'second@example.com' });
  const add = (uid, key) => store.raw.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
    VALUES (?, ?, 'Example Co', 'CTO', 'k', '2026-10-01', 'x', 'x')`).run(uid, key);
  add(OWNER_ID, 'mine');
  add(second, 'theirs');
  const keys = store.db.prepare('SELECT url_key FROM postings WHERE user_id = @uid ORDER BY id').pluck();
  assert.deepEqual(runAsUser(OWNER_ID, () => keys.all()), ['mine']);
  assert.deepEqual(runAsUser(second, () => keys.all()), ['theirs']);
  assert.throws(() => keys.all(), /needs a user/);
  // Named and positional values together, and a statement with no @uid runs anywhere.
  assert.equal(runAsUser(second, () => store.db.prepare('SELECT COUNT(*) FROM postings WHERE user_id = @uid AND url_key = ?').pluck().get('theirs')), 1);
  assert.equal(runAsUser(second, () => store.db.prepare('SELECT COUNT(*) FROM postings WHERE user_id = @uid AND url_key = @k').pluck().get({ k: 'mine' })), 0);
  assert.ok(store.db.prepare('SELECT COUNT(*) FROM lookup_values').pluck().get() > 0);
  // The user flows through awaits and into promises the request starts.
  return runAsUser(second, async () => {
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(keys.all(), ['theirs']);
    const scripts = scopeDb(store.raw, { fallbackUid: OWNER_ID });
    assert.deepEqual(scripts.prepare('SELECT url_key FROM postings WHERE user_id = @uid').pluck().all(), ['theirs'], 'a request user wins over the fallback');
    store.close();
  });
});

test('sign-in: an address with its own active row is that user; a paused one is nobody; any other allowed address is the owner', () => {
  const store = openJobStore(':memory:');
  const second = addUser(store.raw, { email: 'Second@Example.com' });
  assert.equal(userForEmail(store.raw, 'second@example.com'), second);
  assert.equal(userForEmail(store.raw, 'owner@example.com'), OWNER_ID);
  store.raw.prepare("UPDATE users SET status = 'paused' WHERE id = ?").run(second);
  assert.equal(userForEmail(store.raw, 'second@example.com'), null);
  store.close();
});
