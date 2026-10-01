import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { listingReason, isListingPage, excludedSite, skipReason } from '../tools/listings.js';
import { interpretResult, ruleScore, isRuleScored, NO_TEXT_CAP } from '../agents/discovery/score.js';
import { archiveListings, demoteWithoutText } from '../agents/hunt/archive.js';
import { validateManualInput, addPosting } from '../agents/manual.js';
import { listPostings, summary } from '../server/queries.js';

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
  assert.match(r.reason, /Skipped: not a single job/);

  const analysis = { score: 9, reason: 'Great title.', locationConcern: 'none' };
  const capped = interpretResult(analysis, { location_check: 'remote' });
  assert.equal(capped.score, NO_TEXT_CAP);
  assert.equal(capped.analysis.uncappedScore, 9);
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

test("status groups: Needs action is new and offer; In progress is applied, interviewing, and offer", () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  for (const status of ['new', 'applied', 'interviewing', 'offer', 'passed', 'closed', 'rejected']) insert(db, { title: `Job ${status}`, status });
  const statuses = (filters) => listPostings(db, filters).map((r) => r.status).sort();
  assert.deepEqual(statuses({ status: 'active' }), ['new', 'offer']);
  assert.deepEqual(statuses({ status: 'progress' }), ['applied', 'interviewing', 'offer']);
  assert.equal(statuses({ status: 'all' }).length, 7);
  assert.deepEqual(statuses({ status: 'closed' }), ['closed']);
  store.close();
});

const excluding = { search: { excludedSites: ['payjobs.example'] } };

test('excluded sites match the domain and its subdomains only', () => {
  assert.equal(excludedSite('https://www.payjobs.example/job/vp-1.html', ['payjobs.example']), 'payjobs.example');
  assert.equal(excludedSite('https://payjobs.example/x', ['www.payjobs.example']), 'www.payjobs.example');
  assert.equal(excludedSite('https://notpayjobs.example/x', ['payjobs.example']), null);
  assert.equal(excludedSite('not a url', ['payjobs.example']), null);
  assert.equal(skipReason({ title: 'VP Engineering', url: 'https://www.payjobs.example/j/1' }, excluding), 'excluded site (payjobs.example)');
  assert.equal(skipReason({ title: 'VP Engineering', url: 'https://www.payjobs.example/j/1' }, {}), null, 'no setting, no exclusion');
  assert.equal(ruleScore({ title: 'VP Engineering', url: 'https://payjobs.example/j/1' }, excluding).score, 1);
  assert.ok(isRuleScored({ title: 'VP Engineering', url: 'https://payjobs.example/j/1' }, excluding));
});

test('manual add refuses an excluded site before fetching anything', async () => {
  const store = openJobStore(':memory:');
  const http = { get: () => assert.fail('no fetch for an excluded site') };
  await assert.rejects(addPosting({ url: 'https://www.payjobs.example/job/1' }, { store, config: excluding, http }), /excluded in your settings/);
  store.close();
});

test('cleanup archives excluded-site jobs and moves pipeline jobs without a description to Discovered', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const paid = insert(db, { title: 'VP Engineering', url: 'https://www.payjobs.example/job/1', stage: 'discovered' });
  const noText = insert(db, { title: 'Director of Engineering' });
  const appliedNoText = insert(db, { title: 'Head of Engineering', status: 'applied' });
  const withText = insert(db, { title: 'CTO' });
  db.prepare("UPDATE postings SET fetched_text = 'The full posting.' WHERE id = ?").run(withText);

  const { archived } = archiveListings(db, { config: excluding, now: new Date('2026-10-01T12:00:00Z') });
  assert.deepEqual(archived.map((p) => p.id), [paid]);
  assert.match(db.prepare('SELECT notes FROM postings WHERE id = ?').pluck().get(paid), /^Removed 2026-10-01: excluded site \(payjobs\.example\)\.$/);

  assert.deepEqual(demoteWithoutText(db, { dryRun: true }).demoted.map((p) => p.id), [noText]);
  demoteWithoutText(db);
  const stage = (id) => db.prepare('SELECT stage FROM postings WHERE id = ?').pluck().get(id);
  assert.deepEqual([stage(noText), stage(appliedNoText), stage(withText)], ['discovered', 'pipeline', 'pipeline']);
  store.close();
});

test('jobs judged 7+ without a description are flagged and counted; others are not', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const today = new Date().toISOString().slice(0, 10);
  const add = (title, o = {}) => {
    const id = insert(db, { title, stage: 'discovered', ...o });
    db.prepare('UPDATE postings SET discovered_on = ? WHERE id = ?').run(o.discoveredOn ?? today, id);
    return id;
  };
  const score = (id, value, source, analysis = {}) =>
    db.prepare("INSERT INTO scores (posting_id, score, reason, analysis_json, source, created_at) VALUES (?, ?, 'r', ?, ?, 'x')").run(id, value, JSON.stringify(analysis), source);
  const v1High = add('VP Engineering');
  score(v1High, 9, 'v1-quick');
  const capped = add('Head of Engineering');
  score(capped, 5, 'v2', { uncappedScore: 8 });
  const low = add('Engineering Manager');
  score(low, 5, 'v2');
  const old = add('Director', { discoveredOn: '2026-01-01' });
  score(old, 9, 'v1-quick');
  const passed = add('CTO', { status: 'passed' });
  score(passed, 9, 'v1-quick');

  const flagged = listPostings(db, { stage: 'all', status: 'all' }).filter((r) => r.awaitingDescription).map((r) => r.id).sort();
  assert.deepEqual(flagged, [v1High, capped].sort());
  assert.deepEqual(listPostings(db, { needsDescription: 'true' }).map((r) => r.id).sort(), [v1High, capped].sort());
  assert.equal(summary(db).needsDescription, 2);
  store.close();
});

test('duplicates: the copy the user acted on is kept, extra new copies are archived with a pointer', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const add = (title, company, o = {}) => {
    const id = insert(db, { title, stage: 'discovered', ...o });
    db.prepare('UPDATE postings SET company = ?, company_title_key = ? WHERE id = ?').run(company, `${company}|${title}`.toLowerCase(), id);
    return id;
  };
  const applied = add('Director of Engineering', 'Example Co', { status: 'applied', stage: 'pipeline' });
  const googleCopy = add('Job Application for Director of Engineering at Example Co', 'See posting');
  const plainCopy = add('Director of Engineering', 'Example Co');
  const other = add('VP Engineering', 'Example Co');
  const unknownA = add('CTO', 'See posting');
  const unknownB = add('CTO', 'See posting');

  const { archived } = archiveListings(db, { now: new Date('2026-10-01T12:00:00Z') });
  assert.deepEqual(archived.map((p) => p.id), [googleCopy, plainCopy]);
  assert.match(archived[0].reason, new RegExp(`^duplicate of #${applied}, Director of Engineering at Example Co, pipeline/applied$`));
  const stage = (id) => db.prepare('SELECT stage FROM postings WHERE id = ?').pluck().get(id);
  assert.deepEqual([applied, other, unknownA, unknownB].map(stage), ['pipeline', 'discovered', 'discovered', 'discovered'], 'placeholder companies never match each other');

  // Two new copies, no acted-on one: the oldest stays. Running again must not flip to the removed copy.
  const first = add('Head of Engineering', 'Other Co');
  const second = add('Head of Engineering', 'Other Co');
  assert.deepEqual(archiveListings(db).archived.map((p) => p.id), [second]);
  assert.equal(archiveListings(db).archived.length, 0, 'a second run finds nothing');
  assert.equal(stage(first), 'discovered');
  store.close();
});

test('rows carry pay from the job terms, the source salary, or the description, in that order', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const listed = insert(db, { title: 'VP Engineering A' });
  db.prepare("UPDATE postings SET salary = '$200k - $250k', fetched_text = 'Salary $100,000 - $120,000.' WHERE id = ?").run(listed);
  const described = insert(db, { title: 'VP Engineering B' });
  db.prepare("UPDATE postings SET fetched_text = 'The range is $180,000 to $220,000 annually.' WHERE id = ?").run(described);
  const terms = insert(db, { title: 'Fractional CTO' });
  db.prepare("UPDATE postings SET rate_min = 150, rate_max = 200, rate_unit = 'hour', rate_text = '$150 - $200/hr', hours_min = 10, hours_max = 10 WHERE id = ?").run(terms);
  const none = insert(db, { title: 'VP Engineering C' });

  const rows = Object.fromEntries(listPostings(db, {}, { fractional: { weeksPerYear: 48 } }).map((r) => [r.id, r]));
  assert.deepEqual([rows[listed].pay.min, rows[listed].pay.from], [200000, 'source']);
  assert.deepEqual([rows[described].pay.max, rows[described].pay.from], [220000, 'description']);
  assert.deepEqual([rows[terms].pay.unit, rows[terms].pay.from, rows[terms].annualized.low], ['hour', 'terms', 72000]);
  assert.equal(rows[none].pay, null);
  store.close();
});

test('editing the company finds the earlier copy, and duplicateOf archives this one with a note', async () => {
  const { updatePosting, getPosting } = await import('../server/queries.js');
  const { rekeyPostings, findCopies } = await import('../agents/identity.js');
  const store = openJobStore(':memory:');
  const { db } = store;
  const set = (id, company, title) => db.prepare('UPDATE postings SET company = ?, title = ? WHERE id = ?').run(company, title, id);
  const applied = insert(db, { title: 'x', status: 'applied' });
  set(applied, 'Example Health', 'VP of Engineering');
  const copy = insert(db, { title: 'x' });
  set(copy, 'See posting', 'Vice President, Engineering (Remote)');
  const other = insert(db, { title: 'x' });
  set(other, 'See posting', 'Vice President, Engineering (Remote)');
  rekeyPostings(db);
  assert.deepEqual(findCopies(db, db.prepare('SELECT * FROM postings WHERE id = ?').get(copy)), [], 'a placeholder company matches nothing');
  assert.equal(listPostings(db, {}).find((r) => r.id === copy).hasCopies, false, 'two "See posting" rows are not flagged as copies');

  const edited = updatePosting(db, copy, { company: 'Example Health, Inc.' });
  assert.deepEqual(edited.copies.map((c) => [c.id, c.status]), [[applied, 'applied']]);
  assert.equal(listPostings(db, {}).find((r) => r.id === copy).hasCopies, true);

  const archived = updatePosting(db, copy, { duplicateOf: applied }, {}, new Date('2026-10-01T12:00:00Z'));
  assert.equal(archived.stage, 'archived');
  assert.equal(archived.status, 'new', 'status is left alone so the scoring eval does not read it as a pass');
  assert.ok(archived.notes.endsWith(`Duplicate of #${applied}, VP of Engineering at Example Health (pipeline/applied); archived 2026-10-01.`), archived.notes);
  assert.throws(() => updatePosting(db, copy, { duplicateOf: copy }), /not found/);
  assert.equal(getPosting(db, other).copies.length, 0);
  store.close();
});

test('duplicates: a new pipeline copy is kept over an old copy archived for age or left in Discovered', () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const add = (o) => {
    const id = insert(db, { title: 'x', ...o });
    db.prepare("UPDATE postings SET company = 'Example Co', title = 'Engineering Manager', company_title_key = 'example|engineering manager' WHERE id = ?").run(id);
    return id;
  };
  const oldArchived = add({ stage: 'archived' });
  const oldDiscovered = add({ stage: 'discovered' });
  const fresh = add({ stage: 'pipeline' });
  assert.deepEqual(archiveListings(db, { dryRun: true }).archived.map((p) => p.id), [oldDiscovered]);
  assert.ok(fresh > oldArchived);
  store.close();
});

test("discovery's first status entry does not count as removed by cleanup", () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const add = (stage) => {
    const id = insert(db, { title: 'x', stage });
    db.prepare("UPDATE postings SET company = 'Example Co', title = 'CTO', company_title_key = 'example|chief technology officer' WHERE id = ?").run(id);
    db.prepare("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, NULL, 'new', 'agent', 'x')").run(id);
    return id;
  };
  const older = add('discovered');
  const fresh = add('pipeline');
  assert.deepEqual(archiveListings(db, { dryRun: true }).archived.map((p) => p.id), [older], 'the pipeline copy is kept');
  assert.ok(fresh);
  store.close();
});

test('copies already archived as duplicates are not pointed out again', async () => {
  const { updatePosting, getPosting } = await import('../server/queries.js');
  const store = openJobStore(':memory:');
  const { db } = store;
  const add = (o) => {
    const id = insert(db, { title: 'x', ...o });
    db.prepare("UPDATE postings SET company = 'Example Co', title = 'CTO', company_title_key = 'example|chief technology officer' WHERE id = ?").run(id);
    return id;
  };
  const kept = add({ stage: 'pipeline' });
  const copy = add({ stage: 'discovered' });
  assert.equal(listPostings(db, {}).find((r) => r.id === kept).hasCopies, true);
  updatePosting(db, copy, { duplicateOf: kept });
  assert.equal(listPostings(db, {}).find((r) => r.id === kept).hasCopies, false);
  assert.deepEqual(getPosting(db, kept).copies, []);
  const passedEarlier = add({ stage: 'archived', status: 'passed' });
  db.prepare("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, 'new', 'passed', 'user', 'x')").run(passedEarlier);
  assert.deepEqual(getPosting(db, kept).copies.map((c) => c.id), [passedEarlier], 'a copy the user passed on is shown');
  store.close();
});
