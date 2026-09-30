import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { collectReport, renderReport } from '../agents/hunt/report.js';
import { archivePostings, findArchivable } from '../agents/hunt/archive.js';

// Synthetic postings only.
function addPosting(db, { stage = 'pipeline', status = 'new', discovered = '2026-09-29', company = 'Example Co', title = 'VP Engineering' } = {}) {
  const url = `https://jobs.example.com/${Math.random()}`;
  return Number(
    db.prepare(`INSERT INTO postings (url, url_key, company, title, company_title_key, stage, status, location, discovered_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Remote', ?, 'x', 'x')`).run(url, url, company, title, url, stage, status, discovered).lastInsertRowid,
  );
}

test('collectReport and renderReport cover new, promoted, pipeline, cost and failures, all escaped', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const since = '2026-09-30T00:00:00.000Z';
  db.prepare(`INSERT INTO runs (name, status, started_at, cost_usd, summary) VALUES
    ('discover', 'ok', '2026-09-30T06:00:00.000Z', 0, ?), ('score', 'ok', '2026-09-30T06:05:00.000Z', 0.42, ?),
    ('hunt', 'failed', '2026-09-30T06:10:00.000Z', 0.10, NULL), ('score', 'ok', '2026-09-29T06:00:00.000Z', 9.99, NULL)`)
    .run(
      JSON.stringify({ inserted: 12, bySource: { LinkedIn: { new: 9 }, Himalayas: { new: 3 } }, locationChecks: { remote: 10, home: 2 } }),
      JSON.stringify({ distribution: { 8: 1, 5: 11 } }),
    );
  const star = addPosting(db, { company: 'Acme <script>', title: 'CTO & Founder' });
  db.prepare(`INSERT INTO scores (posting_id, score, reason, analysis_json, source, created_at) VALUES (?, 8, 'Great fit', ?, 'v2', '2026-09-30T06:05:00.000Z')`)
    .run(star, JSON.stringify({ topTalkingPoint: 'Scaled platform' }));
  db.prepare(`INSERT INTO artifacts (posting_id, kind, doc_url, flags_json, source, created_at) VALUES (?, 'cover_letter', 'https://docs.example.com/1', '["weak closer"]', 'v2', 'x')`).run(star);
  const old = addPosting(db, { status: 'applied', company: 'Older Co' });
  db.prepare(`INSERT INTO scores (posting_id, score, source, created_at) VALUES (?, 9, 'v2', '2026-09-20T00:00:00.000Z')`).run(old); // promoted earlier
  addPosting(db, { stage: 'discovered' });

  const data = collectReport(db, { since });
  assert.equal(data.promoted.length, 1);
  assert.equal(data.pipeline.length, 2);
  assert.ok(Math.abs(data.costUsd - 0.52) < 1e-9, 'only runs since the start count');
  assert.deepEqual(data.failedSteps, ['hunt']);
  assert.deepEqual(data.statusCounts, { new: 1, applied: 1 });

  const { subject, html, text } = renderReport(data, { now: new Date(2026, 8, 30) });
  assert.equal(subject, 'Job Agent: 12 new, 1 promoted | Sep 30');
  assert.match(html, /Acme &lt;script&gt;/);
  assert.ok(!html.includes('<script>'), 'scraped text is escaped');
  assert.match(html, /CTO &amp; Founder/);
  assert.match(html, /needs review: weak closer/);
  assert.match(html, /Lead with:<\/b> Scaled platform/);
  assert.match(html, /These steps failed: hunt/);
  assert.match(html, /LinkedIn: 9 new/);
  assert.match(html, /run cost \$0\.52/);
  assert.equal(text, '12 new postings, 1 promoted, 2 in pipeline, cost $0.52');
  store.close();
});

test('archive moves closed/passed/rejected now and stale jobs after 30 days, keeping active conversations', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const now = new Date(2026, 8, 30);
  const closed = addPosting(db, { status: 'closed' });
  const passed = addPosting(db, { status: 'passed' });
  const staleApplied = addPosting(db, { status: 'applied', discovered: '2026-08-01' });
  addPosting(db, { status: 'interviewing', discovered: '2026-07-01' }); // kept
  addPosting(db, { status: 'new', discovered: '2026-09-25' }); // recent, kept
  addPosting(db, { stage: 'discovered', status: 'closed' }); // not in the pipeline

  const preview = archivePostings(db, { now, dryRun: true });
  assert.deepEqual(preview.archived.map((m) => m.id), [closed, passed, staleApplied]);
  assert.match(preview.archived[2].reason, /over 30 days/);
  assert.equal(db.prepare("SELECT COUNT(*) FROM postings WHERE stage = 'pipeline'").pluck().get(), 5, 'dry run changes nothing');

  const done = archivePostings(db, { now });
  assert.equal(done.archived.length, 3);
  assert.equal(done.remaining, 2);
  assert.equal(db.prepare("SELECT stage || '/' || status FROM postings WHERE id = ?").pluck().get(passed), 'archived/passed');
  assert.equal(findArchivable(db, { now }).length, 0);
  store.close();
});
