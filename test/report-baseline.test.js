import { asEngine } from '../db/engine/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openJobStore } from '../db/index.ts';
import { addUser } from '../db/users.ts';
import { baselineReport, renderBaseline } from '../tools/baseline.ts';

// Synthetic data only. "now" is fixed so waiting days are stable.
const now = new Date('2026-10-05T12:00:00Z');
const SECRET = 'Zebracorn Widgets';

async function build() {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-'));
  const path = join(dir, 'job-agent.db');
  const store = openJobStore(path, { snapshot: false });
  const { raw } = store;
  await addUser(raw, { email: 'second@example.com', name: 'Second' });
  const job = async (/** @type {number} */ uid, /** @type {Record<string, string | null>} */ o = {}) =>
    Number(
      (await asEngine(raw)
        .prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, source, track, discovered_on, stage, status, applied_on, created_at, updated_at)
          VALUES (@user, @k, @company, 'CTO', @k, 'LinkedIn', 'fulltime', '2026-06-01', 'pipeline', @status, @applied, 'x', 'x')`)
        .run({ user: uid, k: `k${Math.random()}`, company: SECRET, status: 'applied', applied: null, ...o })).id,
    );
  const old = await job(1, { applied: '2026-06-01' }); // stale (no reply for months)
  await job(1, { applied: '2026-09-20' }); // worth a follow-up
  await job(1); // applied, no date (dated from discovery, so also stale)
  await job(1, { status: 'new' }); // not an application
  const second = await job(2, { applied: '2026-10-01' }); // too recent for a follow-up
  await asEngine(raw).prepare(`INSERT INTO emails (user_id, id, gmail_message_id, thread_id, sender, sender_domain, sent_at, type, posting_id, review_status, created_at, updated_at)
    VALUES (2, ?, ?, 't', 'x@example.com', 'example.com', '2026-10-02T09:00:00Z', 'confirmation', ?, 'auto', 'x', 'x')`).run(randomUUID(), randomUUID(), second);
  const run = (await asEngine(raw).prepare("INSERT INTO runs (name, status, started_at, user_id) VALUES ('score', 'ok', '2026-09-01T00:00:00Z', 1)").run()).id;
  const call = asEngine(raw).prepare("INSERT INTO run_calls (run_id, label, cost_usd, created_at) VALUES (?, 'score', ?, ?)");
  await call.run(run, 0.25, '2026-09-03T00:00:00Z');
  await call.run(run, 0.5, '2026-09-30T00:00:00Z');
  await call.run(run, 1, '2026-10-01T00:00:00Z');
  store.close();
  const attachments = join(dir, 'attachments', String(old));
  mkdirSync(attachments, { recursive: true });
  writeFileSync(join(attachments, randomUUID()), Buffer.alloc(1000));
  return { dir, path, attachmentsDir: join(dir, 'attachments') };
}

test('baseline: counts, sizes, spend, and outcome data across users, read-only and without text', async () => {
  const { dir, path, attachmentsDir } = await build();
  try {
    const before = readFileSync(path);
    const r = await baselineReport(path, { attachmentsDir, now });
    assert.deepEqual(readFileSync(path), before, 'the file is unchanged');

    assert.equal(r.tables.find((t) => t.table === 'postings')?.rows, 5);
    assert.equal(r.tables.find((t) => t.table === 'users')?.rows, 2);
    assert.ok(r.database.bytes > 0 && r.database.pageCount > 0);
    assert.deepEqual(r.attachments, { files: 1, bytes: 1000 });
    assert.deepEqual(r.spendByMonth, [
      { month: '2026-09', usd: 0.75, calls: 2 },
      { month: '2026-10', usd: 1, calls: 1 },
    ]);
    assert.deepEqual(r.usersByStatus, [{ status: 'active', count: 2 }]);
    assert.deepEqual(r.outcomes, { applications: 4, noAppliedOn: 1, withLinkedEmail: 1, followUp: 1, stale: 2 });

    for (const out of [renderBaseline(r), JSON.stringify(r)]) {
      // No company, title, or email address from any row (a regex: CodeQL reads includes() of a host as a URL check).
      assert.doesNotMatch(out, new RegExp(`${SECRET}|CTO|@`), 'no text from any row');
    }
    assert.deepEqual((await baselineReport(path, { attachmentsDir: join(dir, 'none'), now })).attachments, { files: 0, bytes: 0 }, 'no attachments folder yet');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('baseline: a missing database is an error, never a new file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-'));
  try {
    await assert.rejects(async () => await baselineReport(join(dir, 'none.db')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
