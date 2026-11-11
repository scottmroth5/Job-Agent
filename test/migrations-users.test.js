// Migration 013 (multi-user, phase 1) on a database that already has a job search: every row becomes the owner's,
// nothing is lost or unlinked, keys become unique per user, and user_id is required. Synthetic data only.
import { asEngine } from '../db/engine/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@scottmroth5/agent-core';
import { loadMigrations, openJobStore } from '../db/index.ts';
import { USER_TABLES } from '../db/migrations/013-users.ts';
import { runAsUser, scopeDb } from '../db/scope.ts';
import { accountFor, addUser, OWNER_ID, syncOwnerEmail } from '../db/users.ts';

/** @param {string} path */
async function before013(path) {
  const store = openStore(path, { app: 'job-agent', migrations: loadMigrations().filter((m) => m.id < '013') });
  const { db } = store;
  const run = async (/** @type {string} */ sql, /** @type {unknown[]} */ ...args) => await asEngine(db).prepare(sql).run(...args);
  const job = async (/** @type {string} */ key) => Number((await run(`INSERT INTO postings (url, url_key, company, title, company_title_key, discovered_on, stage, status, notes, created_at, updated_at)
    VALUES (?, ?, 'Example Co', 'CTO', ?, '2026-10-01', 'pipeline', 'applied', 'A note', 'x', 'x')`, `https://jobs.example.com/${key}`, key, `example|cto|${key}`)).id);
  const a = await job('a');
  const b = await job('b');
  await run("INSERT INTO scores (posting_id, score, source, created_at) VALUES (?, 8, 'v2', 'x')", a);
  await run("INSERT INTO artifacts (posting_id, kind, content, source, created_at) VALUES (?, 'cover_letter', 'Body', 'v2', 'x')", a);
  await run("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, 'new', 'applied', 'user', 'x')", a);
  await run("INSERT INTO posting_notes (id, posting_id, body, source, created_at, updated_at) VALUES ('n1', ?, 'A note', 'earlier', 'x', 'x')", a);
  await run("INSERT INTO posting_sightings (posting_id, source, url, seen_on) VALUES (?, 'linkedin', 'https://jobs.example.com/a', 'x')", a);
  await run("INSERT INTO attachments (id, posting_id, filename, content_type, size_bytes, sha256, created_at) VALUES ('f1', ?, 'r.pdf', 'application/pdf', 1, 'h', 'x')", a);
  await run("INSERT INTO meeting_preps (id, posting_id, attendees_json, content, model, created_at) VALUES ('m1', ?, '[]', 'Prep', 'model', 'x')", a);
  await run("INSERT INTO email_threads (thread_id, posting_id, kind, created_at) VALUES ('t1', ?, 'application', 'x')", a);
  await run(`INSERT INTO emails (id, gmail_message_id, thread_id, sender, sender_domain, sent_at, type, posting_id, review_status, created_at, updated_at)
    VALUES ('e1', 'g1', 't1', 'hr@example.com', 'example.com', 'x', 'confirmation', ?, 'auto', 'x', 'x')`, a);
  await run("INSERT INTO contacts (id, email, posting_id, source, created_at, updated_at) VALUES ('c1', 'hr@example.com', ?, 'email', 'x', 'x')", a);
  await run("INSERT INTO reminders (id, posting_id, email_id, kind, created_at) VALUES ('r1', ?, 'e1', 'assessment', 'x')", a);
  await run("INSERT INTO decision_log (id, posting_id, email_id, action, decided_by, created_at) VALUES ('d1', ?, 'e1', 'link', 'rule', 'x')", a);
  await run("INSERT INTO prompt_versions (name, template, active, created_at) VALUES ('score', 'Edited {{candidateName}}', 1, 'x')");
  for (const [k, v] of [['inbox.historyId', '500'], ['drive.coverLetterFolderId', 'folder-1'], ['layout:home', '["inbox"]'], ['claude.monthlyBudgetUsd', '40']]) {
    await run('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)', k, v, 'x');
  }
  store.close();
  return { a, b };
}

test('013 gives every row to the owner, keeps every link, and moves personal settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm013-'));
  try {
    const path = join(dir, 'job-agent.db');
    const { a, b } = await before013(path);
    const store = openJobStore(path, { log: {} });
    const raw = store.raw;
    for (const t of USER_TABLES) {
      const rows = await asEngine(raw).prepare(`SELECT user_id FROM "${t}"`).pluck().all();
      assert.ok(rows.length > 0, `${t} has rows`);
      assert.ok(rows.every((u) => u === OWNER_ID), `${t} rows are the owner's`);
    }
    assert.equal(await asEngine(raw).prepare('SELECT COUNT(*) FROM postings').pluck().get(), 2);
    for (const t of ['scores', 'artifacts', 'status_history', 'posting_notes', 'posting_sightings', 'attachments', 'meeting_preps', 'email_threads', 'emails', 'contacts', 'reminders', 'decision_log']) {
      assert.equal(await asEngine(raw).prepare(`SELECT COUNT(*) FROM ${t} WHERE posting_id = ?`).pluck().get(a), 1, `${t} still points at the job`);
    }
    assert.deepEqual(raw.pragma('foreign_key_check'), []);
    assert.equal(raw.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(raw.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(await asEngine(raw).prepare('SELECT key FROM user_settings ORDER BY key').pluck().all(), ['drive.coverLetterFolderId', 'inbox.historyId', 'layout:home']);
    assert.deepEqual(await asEngine(raw).prepare('SELECT key FROM app_settings').pluck().all(), ['claude.monthlyBudgetUsd'], 'app-wide settings stay');
    assert.equal(await asEngine(raw).prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'application_funnel'").pluck().get(), 0);
    assert.equal(await asEngine(raw).prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'postings'").pluck().get(), 2, 'the list checks are back');
    await assert.rejects(async () => await asEngine(raw).prepare("UPDATE postings SET status = 'maybe' WHERE id = ?").run(a), /status is not in the status list/);
    assert.deepEqual(await asEngine(raw).prepare("SELECT role, status FROM users WHERE id = ?").get(OWNER_ID), { role: 'admin', status: 'active' });

    // Cascades still reach the rebuilt children.
    await asEngine(raw).prepare('DELETE FROM postings WHERE id = ?').run(b);
    await asEngine(raw).prepare('DELETE FROM postings WHERE id = ?').run(a);
    assert.equal(await asEngine(raw).prepare('SELECT COUNT(*) FROM scores').pluck().get(), 0);
    assert.equal(await asEngine(raw).prepare('SELECT COUNT(*) FROM emails WHERE posting_id IS NOT NULL').pluck().get(), 0, 'emails are unlinked, not deleted');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keys are unique per user, and user_id is required', async () => {
  const store = openJobStore(':memory:');
  const raw = store.raw;
  const second = await addUser(raw, { email: 'second@example.com' });
  const job = async (/** @type {number} */ uid, /** @type {string} */ key) => await asEngine(raw).prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
    VALUES (?, ?, 'Example Co', 'CTO', 'k', '2026-10-01', 'x', 'x')`).run(uid, key);
  await job(OWNER_ID, 'same');
  await job(second, 'same');
  await assert.rejects(async () => await job(OWNER_ID, 'same'), /UNIQUE/);
  await assert.rejects(async () => await asEngine(raw).prepare("INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, created_at, updated_at) VALUES ('x', 'C', 'T', 'k', 'd', 'x', 'x')").run(), /NOT NULL constraint failed: postings.user_id/);
  await assert.rejects(async () => await job(99, 'ghost'), /FOREIGN KEY/);
  const contact = async (/** @type {number} */ uid) => await asEngine(raw).prepare("INSERT INTO contacts (user_id, id, email, source, created_at, updated_at) VALUES (?, ?, 'hr@example.com', 'email', 'x', 'x')").run(uid, `c${uid}`);
  await contact(OWNER_ID);
  await contact(second);
  await assert.rejects(async () => await asEngine(raw).prepare("INSERT INTO contacts (user_id, id, email, source, created_at, updated_at) VALUES (?, 'c9', 'hr@example.com', 'email', 'x', 'x')").run(OWNER_ID), /UNIQUE/);
  store.close();
});

test('scopeDb binds the current user, and a user-table query with no user throws', async () => {
  const store = openJobStore(':memory:', { fallbackUid: null });
  const second = await addUser(store.raw, { email: 'second@example.com' });
  const add = (/** @type {number} */ uid, /** @type {string} */ key) => store.raw.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
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
  assert.ok(/** @type {number} */ (store.db.prepare('SELECT COUNT(*) FROM lookup_values').pluck().get()) > 0);
  // The user flows through awaits and into promises the request starts.
  return runAsUser(second, async () => {
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(keys.all(), ['theirs']);
    const scripts = scopeDb(store.raw, { fallbackUid: OWNER_ID });
    assert.deepEqual(scripts.prepare('SELECT url_key FROM postings WHERE user_id = @uid').pluck().all(), ['theirs'], 'a request user wins over the fallback');
    store.close();
  });
});

test('sign-in: an owner address is the owner; any other address is its own row (with its status), or nobody yet', async () => {
  const store = openJobStore(':memory:');
  const second = await addUser(store.raw, { email: 'Second@Example.com' });
  const owners = ['Owner@Example.com', 'other-owner@example.com'];
  assert.deepEqual(await accountFor(store.raw, 'second@example.com', owners), { uid: second, status: 'active', role: 'user' });
  assert.deepEqual(await accountFor(store.raw, 'owner@example.com', owners), { uid: OWNER_ID, status: 'active', role: 'admin' });
  assert.equal((await accountFor(store.raw, 'other-owner@example.com', owners))?.uid, OWNER_ID);
  assert.equal(await accountFor(store.raw, 'stranger@example.com', owners), null);
  await asEngine(store.raw).prepare("UPDATE users SET status = 'paused' WHERE id = ?").run(second);
  assert.equal((await accountFor(store.raw, 'second@example.com', owners))?.status, 'paused');
  await syncOwnerEmail(store.raw, owners);
  assert.equal(await asEngine(store.raw).prepare('SELECT email FROM users WHERE id = ?').pluck().get(OWNER_ID), 'owner@example.com');
  store.close();
});
