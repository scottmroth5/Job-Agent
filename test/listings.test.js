import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { listingReason, isListingPage } from '../tools/listings.js';
import { interpretResult, ruleScore, isRuleScored, NO_TEXT_CAP } from '../agents/discovery/score.js';
import { archiveListings } from '../agents/hunt/archive.js';
import { validateManualInput } from '../agents/manual.js';
import { listPostings } from '../server/queries.js';

// Synthetic titles and links in the shapes seen in Google results; no real data.
test('list-of-jobs titles and search links are recognized', () => {
  for (const title of [
    'CTO Jobs and Vacancies: Hand-Reviewed Roles | Example Jobs HQ',
    'Vice President Of Engineering jobs in Remote - Indeed',
    'Remote Engineering Manager Jobs',
    '123 Chief technology officer jobs in Someland',
    'Head of Engineering Vacancies',
  ]) {
    assert.ok(isListingPage({ title }), title);
  }
  for (const url of [
    'https://www.indeed.com/q-vp-engineering-remote-jobs.html',
    'https://www.indeed.com/jobs?q=cto&l=remote',
    'https://www.ziprecruiter.com/Jobs/Vp-Engineering',
    'https://www.linkedin.com/jobs/search?keywords=cto',
  ]) {
    assert.equal(listingReason({ title: 'VP Engineering', url }), 'the link is a job search page', url);
  }
});

test('single jobs are not mistaken for lists', () => {
  for (const posting of [
    { title: 'Director, AI Engineering (2 Openings)' },
    { title: 'Engineering Manager Several Openings!' },
    { title: 'VP Engineering', url: 'https://example.wd1.myworkdayjobs.com/en-US/Search/job/VP-Engineering_123' },
    { title: 'VP Engineering', url: 'https://example.wd5.myworkdayjobs.com/en-US/site/details/VP-Engineering_1?q=engineering' },
    { title: 'VP Engineering', url: 'https://www.linkedin.com/jobs/search-results/?currentJobId=123&trackingId=x' },
    { title: 'VP Engineering', url: 'https://www.indeed.com/viewjob?jk=abc123' },
  ]) {
    assert.equal(listingReason(posting), null, JSON.stringify(posting));
  }
});

test('a list page scores 1 by rule; a job with no text is capped below promotion', () => {
  const listing = { title: 'Remote CTO Jobs', location_check: 'remote' };
  assert.ok(isRuleScored(listing));
  const r = ruleScore(listing, {});
  assert.equal(r.score, 1);
  assert.match(r.reason, /Not a single job/);

  const analysis = { score: 9, reason: 'Great title.', locationConcern: 'none' };
  const capped = interpretResult(analysis, { location_check: 'remote' });
  assert.equal(capped.score, NO_TEXT_CAP);
  assert.match(capped.reason, /no posting text/);
  assert.equal(interpretResult({ ...analysis }, { location_check: 'remote', jd_text: 'Pasted text.' }).score, 9);
});

test('manual add refuses a list page', () => {
  assert.throws(() => validateManualInput({ url: 'https://www.indeed.com/jobs?q=cto' }), /list of jobs/);
  assert.throws(() => validateManualInput({ title: 'CTO Jobs', company: 'X', description: 'x'.repeat(300) }), /list of jobs/);
});

function insert(db, o) {
  const row = { url: `https://example.com/${Math.random()}`, stage: 'pipeline', status: 'new', ...o };
  return Number(
    db
      .prepare(`INSERT INTO postings (url, url_key, company, title, company_title_key, stage, status, discovered_on, created_at, updated_at)
        VALUES (@url, @url, 'See posting', @title, @url, @stage, @status, '2026-09-21', 'x', 'x')`)
      .run(row).lastInsertRowid,
  );
}

test('archiveListings removes list pages, keeps them for dedupe, and leaves acted-on jobs alone', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const newList = insert(db, { title: 'Remote CTO Jobs' });
  const rejectedList = insert(db, { title: 'VP Engineering jobs in Remote', status: 'rejected' });
  const appliedList = insert(db, { title: 'CTO Jobs', status: 'applied' });
  const realJob = insert(db, { title: 'VP Engineering' });

  assert.deepEqual(archiveListings(db, { dryRun: true }).archived.map((p) => p.id), [newList, rejectedList]);
  assert.equal(db.prepare("SELECT COUNT(*) FROM postings WHERE stage = 'archived'").pluck().get(), 0, 'dry run changes nothing');

  archiveListings(db, { now: new Date('2026-10-01T12:00:00Z') });
  const row = (id) => db.prepare('SELECT stage, status, notes FROM postings WHERE id = ?').get(id);
  assert.deepEqual([row(newList).stage, row(newList).status], ['archived', 'passed']);
  assert.match(row(newList).notes, /Removed 2026-10-01: not a single job/);
  assert.deepEqual([row(rejectedList).stage, row(rejectedList).status], ['archived', 'rejected']);
  assert.deepEqual([row(appliedList).stage, row(appliedList).status], ['pipeline', 'applied']);
  assert.equal(row(realJob).stage, 'pipeline');
  assert.equal(db.prepare('SELECT changed_by FROM status_history WHERE posting_id = ?').pluck().get(newList), 'agent');
  assert.equal(archiveListings(db).archived.length, 0, 'running again finds nothing');
  store.close();
});

test("the 'active' status filter hides passed, closed, and rejected jobs", () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  for (const status of ['new', 'applied', 'interviewing', 'offer', 'passed', 'closed', 'rejected']) insert(db, { title: `Job ${status}`, status });
  const statuses = (filters) => listPostings(db, filters).map((r) => r.status).sort();
  assert.deepEqual(statuses({ status: 'active' }), ['applied', 'interviewing', 'new', 'offer']);
  assert.equal(statuses({ status: 'all' }).length, 7);
  assert.deepEqual(statuses({ status: 'closed' }), ['closed']);
  store.close();
});
