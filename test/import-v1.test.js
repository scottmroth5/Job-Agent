import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { importV1, mapStatus, extractFitScore, parseCoverLetterCell } from '../db/import-v1.js';
import { classifySheetFiles } from '../scripts/import-v1.js';

// Synthetic rows using the real v1 column headers. No real data.
const discoveredRow = (o = {}) => ({
  'Date Discovered': '7/20/2026',
  Source: 'Himalayas',
  Company: 'Acme',
  'Role Title': 'VP Engineering',
  Location: 'Remote',
  'Job Posted': '2 days ago',
  'Job URL': 'https://jobs.example.com/acme/1?utm_source=feed',
  Salary: '$200k - $250k',
  'Job Type': 'Full-time',
  'Fit Score': '6 of 10',
  Analysis: '6 of 10. Solid match on scale, lighter on the domain.',
  Notes: '',
  Status: 'New',
  ...o,
});

const huntRow = (o = {}) => ({
  Discovered: '7/21/2026',
  'Date Applied': '',
  Company: 'Acme',
  'Role Title': 'VP Engineering',
  'Job URL': 'https://jobs.example.com/acme/1',
  'Job Description if URL does not work': '',
  'Notes/Comments': '',
  'Claude Analysis': 'FIT SCORE: 8 of 10. Strong match.\n\nKEY STRENGTHS:\n- a',
  'Resume Tweaks': 'HEADLINE TWEAK: example',
  'Cover Letter': 'Row5_Acme_CoverLetter | saved to cover letters folder | REVIEW: weak closer; "I am confident"',
  Status: 'Applied',
  ...o,
});

const run = (input) => {
  const store = openJobStore(':memory:');
  const counts = importV1(store, input, { now: '2026-09-30T00:00:00.000Z' });
  return { store, db: store.db, counts };
};

test('mapStatus, extractFitScore and parseCoverLetterCell cover the v1 formats', () => {
  assert.deepEqual(mapStatus('Pass/Not Applying'), { status: 'passed', known: true });
  assert.deepEqual(mapStatus(''), { status: 'new', known: true });
  assert.deepEqual(mapStatus('Phone screen'), { status: 'new', known: false });
  assert.equal(extractFitScore('FIT SCORE: 8 of 10.'), 8);
  assert.equal(extractFitScore('7/10 overall'), 7);
  assert.equal(extractFitScore('0 of 10'), 0);
  assert.equal(extractFitScore(''), null);
  assert.deepEqual(parseCoverLetterCell('Row5_Acme_CoverLetter | saved | REVIEW: a; b'), { docName: 'Row5_Acme_CoverLetter', flags: ['a', 'b'] });
  assert.equal(parseCoverLetterCell(''), null);
});

test('a discovered row becomes a posting with a quick score and parsed dates', () => {
  const { db, counts, store } = run({ discovered: [discoveredRow()], hunt: [] });
  const p = db.prepare('SELECT * FROM postings').get();
  assert.equal(p.url_key, 'jobs.example.com/acme/1');
  assert.equal(p.discovered_on, '2026-07-20');
  assert.equal(p.posted_on, '2026-07-18');
  assert.equal(p.stage, 'discovered');
  assert.equal(p.status, 'new');
  assert.deepEqual(db.prepare('SELECT score, reason, source FROM scores').get(), {
    score: 6,
    reason: 'Solid match on scale, lighter on the domain.',
    source: 'v1-quick',
  });
  assert.equal(counts.postingsCreated, 1);
  store.close();
});

test('a full analysis in the discovered sheet is kept as an artifact', () => {
  const analysis = 'ROLE TYPE: Full time\n\nFIT SCORE: 8 of 10. Great.\n\nTOP TALKING POINT: x';
  const { db, store } = run({ discovered: [discoveredRow({ 'Fit Score': '8 of 10', Analysis: analysis })], hunt: [] });
  assert.equal(db.prepare('SELECT reason FROM scores').pluck().get(), null);
  assert.equal(db.prepare("SELECT content FROM artifacts WHERE kind = 'analysis'").pluck().get(), analysis);
  store.close();
});

test('hunt rows update the matching posting and add analysis, tweaks and letter references', () => {
  const { db, counts, store } = run({
    discovered: [discoveredRow({ Status: 'Added to Pipeline' })],
    hunt: [{ name: 'x - Jobs.csv', current: true, rows: [huntRow({ 'Date Applied': '7/25/2026' })] }],
  });
  const p = db.prepare('SELECT * FROM postings').get();
  assert.equal(counts.postingsCreated, 1);
  assert.equal(p.stage, 'pipeline');
  assert.equal(p.status, 'applied');
  assert.equal(p.applied_on, '2026-07-25');
  assert.deepEqual(
    db.prepare('SELECT source, score FROM scores ORDER BY source').all(),
    [{ source: 'v1-analysis', score: 8 }, { source: 'v1-quick', score: 6 }],
  );
  const letter = db.prepare("SELECT doc_name, flags_json, content FROM artifacts WHERE kind = 'cover_letter'").get();
  assert.deepEqual(letter, { doc_name: 'Row5_Acme_CoverLetter', flags_json: '["weak closer","\\"I am confident\\""]', content: null });
  assert.equal(db.prepare("SELECT COUNT(*) FROM artifacts WHERE kind = 'resume_tweaks'").pluck().get(), 1);
  assert.deepEqual(
    db.prepare('SELECT from_status, to_status FROM status_history ORDER BY id').all(),
    [{ from_status: null, to_status: 'new' }, { from_status: 'new', to_status: 'applied' }],
  );
  store.close();
});

test('the current Jobs tab wins over archives, and repeated rows do not duplicate artifacts', () => {
  const { db, store } = run({
    discovered: [],
    hunt: [
      { name: 'x - Archive.csv', current: false, rows: [huntRow({ Status: 'Pass' })] },
      { name: 'x - Jobs.csv', current: true, rows: [huntRow({ Status: 'Applied' })] },
    ],
  });
  const p = db.prepare('SELECT stage, status, source FROM postings').get();
  assert.deepEqual(p, { stage: 'pipeline', status: 'applied', source: 'v1-manual' });
  assert.equal(db.prepare('SELECT COUNT(*) FROM artifacts').pluck().get(), 3);
  assert.equal(db.prepare('SELECT COUNT(*) FROM scores').pluck().get(), 1);
  store.close();
});

test('archive-only rows are archived; rows match by company and title when URLs differ', () => {
  const { db, counts, store } = run({
    discovered: [discoveredRow()],
    hunt: [{ name: 'x - Archive.csv', current: false, rows: [huntRow({ 'Job URL': 'https://other.example.com/9', Status: 'Closed' })] }],
  });
  assert.equal(counts.postingsCreated, 1);
  assert.deepEqual(db.prepare('SELECT stage, status FROM postings').get(), { stage: 'archived', status: 'closed' });
  store.close();
});

test('duplicate discovered URLs merge, rows without company are skipped, unknown statuses are reported', () => {
  const { counts, store } = run({
    discovered: [
      discoveredRow(),
      discoveredRow({ 'Job URL': 'https://jobs.example.com/acme/1/' }),
      discoveredRow({ Company: '' }),
      discoveredRow({ 'Job URL': 'https://jobs.example.com/acme/2', 'Fit Score': '0 of 10' }),
    ],
    hunt: [{ name: 'x - Jobs.csv', current: true, rows: [huntRow({ Status: 'Phone screen' })] }],
  });
  assert.equal(counts.postingsCreated, 2);
  assert.equal(counts.duplicateDiscoveredRows, 1);
  assert.equal(counts.skippedRows, 1);
  assert.equal(counts.outOfRangeScores, 1);
  assert.deepEqual(counts.unknownStatuses, { 'Phone screen': 1 });
  store.close();
});

test('a promoted job missing from every hunt export is archived, not left in the pipeline', () => {
  const { db, store } = run({
    discovered: [discoveredRow({ Status: 'Added to Pipeline' })],
    hunt: [{ name: 'x - Jobs.csv', current: true, rows: [] }],
  });
  assert.deepEqual(db.prepare('SELECT stage, status FROM postings').get(), { stage: 'archived', status: 'new' });
  store.close();
});

test('refuses to import into a database that already has postings', () => {
  const { store } = run({ discovered: [discoveredRow()], hunt: [] });
  assert.throws(() => importV1(store, { discovered: [discoveredRow()], hunt: [] }), /empty database/);
  store.close();
});

test('classifySheetFiles puts archives first and the current Jobs tab last', () => {
  const files = classifySheetFiles(['Hunt - Jobs.csv', 'Discovered Jobs - Sheet1.csv', 'Hunt - Archived 9-28.csv', 'Hunt - Archive.csv', 'notes.txt']);
  assert.deepEqual(files.discovered, ['Discovered Jobs - Sheet1.csv']);
  assert.deepEqual(files.hunt, [
    { name: 'Hunt - Archive.csv', current: false },
    { name: 'Hunt - Archived 9-28.csv', current: false },
    { name: 'Hunt - Jobs.csv', current: true },
  ]);
});
