import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { listingReason, isListingPage, excludedSite, skipReason } from '../tools/listings.ts';
import { interpretResult, ruleScore, isRuleScored, NO_TEXT_CAP } from '../agents/discovery/score.ts';
import { archiveListings, demoteWithoutText } from '../agents/hunt/archive.ts';
import { validateManualInput, addPosting } from '../agents/manual.ts';
import { listPostings, summary } from '../server/queries.ts';
import { fakeConfig, fakeHttp } from './fixtures/fakes.js';
/** @import { ScoreInput } from '../agents/discovery/score.ts' */
/** @import { Db } from '../tools/types.ts' */
/** @import { PostingsRow } from '../db/types.ts' */

/** A posting with only the fields a test sets (scoring reads title, url, location check, and text). */
const scoreInput = (/** @type {Partial<ScoreInput>} */ p) => /** @type {ScoreInput} */ (p);

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
  const listing = scoreInput({ title: 'Remote CTO Jobs', location_check: 'remote' });
  assert.ok(isRuleScored(listing));
  const r = ruleScore(listing, fakeConfig({}));
  assert.equal(r.score, 1);
  assert.match(r.reason, /Skipped: not a single job/);

  const analysis = { score: 9, reason: 'Great title.', locationConcern: 'none' };
  const capped = interpretResult(analysis, scoreInput({ location_check: 'remote' }));
  assert.equal(capped.score, NO_TEXT_CAP);
  assert.equal(capped.analysis.uncappedScore, 9);
  assert.match(String(capped.reason), /no posting text/);
  assert.equal(interpretResult({ ...analysis }, scoreInput({ location_check: 'remote', jd_text: 'Pasted text.' })).score, 9);
});

test('manual add refuses a list page', () => {
  assert.throws(() => validateManualInput({ url: 'https://www.indeed.com/jobs?q=cto' }), /list of jobs/);
  assert.throws(() => validateManualInput({ title: 'CTO Jobs', company: 'X', description: 'x'.repeat(300) }), /list of jobs/);
});

/** @param {Db} db @param {{ title: string, url?: string, stage?: string, status?: string }} o */
async function insert(db, o) {
  const row = { url: `https://example.com/${Math.random()}`, stage: 'pipeline', status: 'new', ...o };
  return Number(
    (await db
      .prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, stage, status, discovered_on, created_at, updated_at)
        VALUES (1, @url, @url, 'See posting', @title, @url, @stage, @status, '2026-09-21', 'x', 'x') RETURNING id`)
      .run(row)).id,
  );
}

test('archiveListings removes list pages, keeps them for dedupe, and leaves acted-on jobs alone', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const newList = await insert(db, { title: 'Remote CTO Jobs' });
  const rejectedList = await insert(db, { title: 'VP Engineering jobs in Remote', status: 'rejected' });
  const appliedList = await insert(db, { title: 'CTO Jobs', status: 'applied' });
  const realJob = await insert(db, { title: 'VP Engineering' });

  assert.deepEqual((await archiveListings(db, { dryRun: true })).archived.map((p) => p.id), [newList, rejectedList]);
  assert.equal(await db.prepare("SELECT COUNT(*) FROM postings WHERE stage = 'archived'").pluck().get(), 0, 'dry run changes nothing');

  await archiveListings(db, { now: new Date('2026-10-01T12:00:00Z') });
  const row = async (/** @type {number} */ id) => /** @type {Pick<PostingsRow, 'stage' | 'status' | 'notes'>} */ (await db.prepare('SELECT stage, status, notes FROM postings WHERE id = ?').get(id));
  assert.deepEqual([(await row(newList)).stage, (await row(newList)).status], ['archived', 'passed']);
  assert.match(String((await row(newList)).notes), /Removed 2026-10-01: not a single job/);
  assert.deepEqual([(await row(rejectedList)).stage, (await row(rejectedList)).status], ['archived', 'rejected']);
  assert.deepEqual([(await row(appliedList)).stage, (await row(appliedList)).status], ['pipeline', 'applied']);
  assert.equal((await row(realJob)).stage, 'pipeline');
  assert.equal(await db.prepare('SELECT changed_by FROM status_history WHERE posting_id = ?').pluck().get(newList), 'agent');
  assert.equal((await archiveListings(db)).archived.length, 0, 'running again finds nothing');
  store.close();
});

test("status groups: Needs action is new and offer; In progress is applied, interviewing, and offer", async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  for (const status of ['new', 'applied', 'interviewing', 'offer', 'passed', 'closed', 'rejected']) await insert(db, { title: `Job ${status}`, status });
  const statuses = async (/** @type {Parameters<typeof listPostings>[1]} */ filters) => (await listPostings(db, filters)).map((r) => r.status).sort();
  assert.deepEqual(await statuses({ status: 'active' }), ['new', 'offer']);
  assert.deepEqual(await statuses({ status: 'progress' }), ['applied', 'interviewing', 'offer']);
  assert.equal((await statuses({ status: 'all' })).length, 7);
  assert.deepEqual(await statuses({ status: 'closed' }), ['closed']);
  store.close();
});

const excluding = fakeConfig({ search: { excludedSites: ['payjobs.example'] } });

test('excluded sites match the domain and its subdomains only', () => {
  assert.equal(excludedSite('https://www.payjobs.example/job/vp-1.html', ['payjobs.example']), 'payjobs.example');
  assert.equal(excludedSite('https://payjobs.example/x', ['www.payjobs.example']), 'www.payjobs.example');
  assert.equal(excludedSite('https://notpayjobs.example/x', ['payjobs.example']), null);
  assert.equal(excludedSite('not a url', ['payjobs.example']), null);
  assert.equal(skipReason({ title: 'VP Engineering', url: 'https://www.payjobs.example/j/1' }, excluding), 'excluded site (payjobs.example)');
  assert.equal(skipReason({ title: 'VP Engineering', url: 'https://www.payjobs.example/j/1' }, {}), null, 'no setting, no exclusion');
  assert.equal(ruleScore(scoreInput({ title: 'VP Engineering', url: 'https://payjobs.example/j/1' }), excluding).score, 1);
  assert.ok(isRuleScored(scoreInput({ title: 'VP Engineering', url: 'https://payjobs.example/j/1' }), excluding));
});

test('manual add refuses an excluded site before fetching anything', async () => {
  const store = openJobStore(':memory:');
  const http = fakeHttp({ get: () => assert.fail('no fetch for an excluded site') });
  // Refused before anything else in the context is used.
  const ctx = /** @type {Parameters<typeof addPosting>[1]} */ ({ store, config: excluding, http });
  await assert.rejects(addPosting({ url: 'https://www.payjobs.example/job/1' }, ctx), /skipped in your settings/);
  store.close();
});

test('cleanup archives excluded-site jobs and moves pipeline jobs without a description to Discovered', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const paid = await insert(db, { title: 'VP Engineering', url: 'https://www.payjobs.example/job/1', stage: 'discovered' });
  const noText = await insert(db, { title: 'Director of Engineering' });
  const appliedNoText = await insert(db, { title: 'Head of Engineering', status: 'applied' });
  const withText = await insert(db, { title: 'CTO' });
  await db.prepare("UPDATE postings SET fetched_text = 'The full posting.' WHERE id = ?").run(withText);

  const { archived } = await archiveListings(db, { config: excluding, now: new Date('2026-10-01T12:00:00Z') });
  assert.deepEqual(archived.map((p) => p.id), [paid]);
  assert.match(/** @type {string} */ (await db.prepare('SELECT notes FROM postings WHERE id = ?').pluck().get(paid)), /^Removed 2026-10-01: excluded site \(payjobs\.example\)\.$/);

  assert.deepEqual((await demoteWithoutText(db, { dryRun: true })).demoted.map((p) => p.id), [noText]);
  await demoteWithoutText(db);
  const stage = async (/** @type {number} */ id) => await db.prepare('SELECT stage FROM postings WHERE id = ?').pluck().get(id);
  assert.deepEqual([await stage(noText), await stage(appliedNoText), await stage(withText)], ['discovered', 'pipeline', 'pipeline']);
  store.close();
});

test('jobs judged 7+ without a description are flagged and counted; others are not', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const today = new Date().toISOString().slice(0, 10);
  /** @param {string} title @param {{ status?: string, discoveredOn?: string }} [o] */
  const add = async (title, o = {}) => {
    const id = await insert(db, { title, stage: 'discovered', ...o });
    await db.prepare('UPDATE postings SET discovered_on = ? WHERE id = ?').run(o.discoveredOn ?? today, id);
    return id;
  };
  /** @param {number} id @param {number} value @param {string} source @param {object} [analysis] */
  const score = async (id, value, source, analysis = {}) =>
    await db.prepare("INSERT INTO scores (user_id, posting_id, score, reason, analysis_json, source, created_at) VALUES (1, ?, ?, 'r', ?, ?, 'x')").run(id, value, JSON.stringify(analysis), source);
  const v1High = await add('VP Engineering');
  await score(v1High, 9, 'v1-quick');
  const capped = await add('Head of Engineering');
  await score(capped, 5, 'v2', { uncappedScore: 8 });
  const low = await add('Engineering Manager');
  await score(low, 5, 'v2');
  const old = await add('Director', { discoveredOn: '2026-01-01' });
  await score(old, 9, 'v1-quick');
  const passed = await add('CTO', { status: 'passed' });
  await score(passed, 9, 'v1-quick');

  const flagged = (await listPostings(db, { stage: 'all', status: 'all' })).filter((r) => r.awaitingDescription).map((r) => r.id).sort();
  assert.deepEqual(flagged, [v1High, capped].sort());
  assert.deepEqual((await listPostings(db, { needsDescription: 'true' })).map((r) => r.id).sort(), [v1High, capped].sort());
  assert.equal((await summary(db)).needsDescription, 2);
  store.close();
});

test('duplicates: the copy the user acted on is kept, extra new copies are archived with a pointer', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  /** @param {string} title @param {string} company @param {{ status?: string, stage?: string }} [o] */
  const add = async (title, company, o = {}) => {
    const id = await insert(db, { title, stage: 'discovered', ...o });
    await db.prepare('UPDATE postings SET company = ?, company_title_key = ? WHERE id = ?').run(company, `${company}|${title}`.toLowerCase(), id);
    return id;
  };
  const applied = await add('Director of Engineering', 'Example Co', { status: 'applied', stage: 'pipeline' });
  const googleCopy = await add('Job Application for Director of Engineering at Example Co', 'See posting');
  const plainCopy = await add('Director of Engineering', 'Example Co');
  const other = await add('VP Engineering', 'Example Co');
  const unknownA = await add('CTO', 'See posting');
  const unknownB = await add('CTO', 'See posting');

  const { archived } = await archiveListings(db, { now: new Date('2026-10-01T12:00:00Z') });
  assert.deepEqual(archived.map((p) => p.id), [googleCopy, plainCopy]);
  assert.match(String(archived[0].reason), new RegExp(`^duplicate of #${applied}, Director of Engineering at Example Co, pipeline/applied$`));
  const stage = async (/** @type {number} */ id) => await db.prepare('SELECT stage FROM postings WHERE id = ?').pluck().get(id);
  assert.deepEqual(await Promise.all([applied, other, unknownA, unknownB].map(stage)), ['pipeline', 'discovered', 'discovered', 'discovered'], 'placeholder companies never match each other');

  // Two new copies, no acted-on one: the oldest stays. Running again must not flip to the removed copy.
  const first = await add('Head of Engineering', 'Other Co');
  const second = await add('Head of Engineering', 'Other Co');
  assert.deepEqual((await archiveListings(db)).archived.map((p) => p.id), [second]);
  assert.equal((await archiveListings(db)).archived.length, 0, 'a second run finds nothing');
  assert.equal(await stage(first), 'discovered');
  store.close();
});

test('rows carry pay from the job terms, the source salary, or the description, in that order', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const listed = await insert(db, { title: 'VP Engineering A' });
  await db.prepare("UPDATE postings SET salary = '$200k - $250k', fetched_text = 'Salary $100,000 - $120,000.' WHERE id = ?").run(listed);
  const described = await insert(db, { title: 'VP Engineering B' });
  await db.prepare("UPDATE postings SET fetched_text = 'The range is $180,000 to $220,000 annually.' WHERE id = ?").run(described);
  const terms = await insert(db, { title: 'Fractional CTO' });
  await db.prepare("UPDATE postings SET rate_min = 150, rate_max = 200, rate_unit = 'hour', rate_text = '$150 - $200/hr', hours_min = 10, hours_max = 10 WHERE id = ?").run(terms);
  const none = await insert(db, { title: 'VP Engineering C' });

  const rows = Object.fromEntries((await listPostings(db, {}, fakeConfig({ fractional: { weeksPerYear: 48 } }))).map((r) => [r.id, r]));
  assert.deepEqual([rows[listed].pay?.min, rows[listed].pay?.from], [200000, 'source']);
  assert.deepEqual([rows[described].pay?.max, rows[described].pay?.from], [220000, 'description']);
  assert.deepEqual([rows[terms].pay?.unit, rows[terms].pay?.from, rows[terms].annualized?.low], ['hour', 'terms', 72000]);
  assert.equal(rows[none].pay, null);
  store.close();
});

test('editing the company finds the earlier copy, and duplicateOf archives this one with a note', async () => {
  const { updatePosting, getPosting } = await import('../server/queries.ts');
  const { rekeyPostings, findCopies } = await import('../agents/identity.ts');
  const store = openJobStore(':memory:');
  const { db } = store;
  const set = async (/** @type {number} */ id, /** @type {string} */ company, /** @type {string} */ title) => await db.prepare('UPDATE postings SET company = ?, title = ? WHERE id = ?').run(company, title, id);
  const applied = await insert(db, { title: 'x', status: 'applied' });
  await set(applied, 'Example Health', 'VP of Engineering');
  const copy = await insert(db, { title: 'x' });
  await set(copy, 'See posting', 'Vice President, Engineering (Remote)');
  const other = await insert(db, { title: 'x' });
  await set(other, 'See posting', 'Vice President, Engineering (Remote)');
  await rekeyPostings(db);
  assert.deepEqual(await findCopies(db, /** @type {PostingsRow} */ (await db.prepare('SELECT * FROM postings WHERE id = ?').get(copy))), [], 'a placeholder company matches nothing');
  assert.equal((await listPostings(db, {})).find((r) => r.id === copy)?.hasCopies, false, 'two "See posting" rows are not flagged as copies');

  const edited = await updatePosting(db, copy, { company: 'Example Health, Inc.' });
  assert.deepEqual(edited?.copies.map((c) => [c.id, c.status]), [[applied, 'applied']]);
  assert.equal((await listPostings(db, {})).find((r) => r.id === copy)?.hasCopies, true);

  const archived = await updatePosting(db, copy, { duplicateOf: applied }, {}, new Date('2026-10-01T12:00:00Z'));
  assert.ok(archived);
  assert.equal(archived.stage, 'archived');
  assert.equal(archived.status, 'duplicate');
  assert.equal(await db.prepare('SELECT changed_by FROM status_history WHERE posting_id = ? ORDER BY id DESC LIMIT 1').pluck().get(copy), 'user');
  assert.ok(String(archived.notes).endsWith(`Duplicate of #${applied}, VP of Engineering at Example Health (pipeline/applied); archived 2026-10-01.`), String(archived.notes));
  await assert.rejects(async () => await updatePosting(db, copy, { duplicateOf: copy }), /not found/);
  assert.equal((await getPosting(db, other))?.copies.length, 0);
  store.close();
});

test('duplicates: a new pipeline copy is kept over an old copy archived for age or left in Discovered', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const add = async (/** @type {{ stage?: string, status?: string }} */ o) => {
    const id = await insert(db, { title: 'x', ...o });
    await db.prepare("UPDATE postings SET company = 'Example Co', title = 'Engineering Manager', company_title_key = 'example|engineering manager' WHERE id = ?").run(id);
    return id;
  };
  const oldArchived = await add({ stage: 'archived' });
  const oldDiscovered = await add({ stage: 'discovered' });
  const fresh = await add({ stage: 'pipeline' });
  assert.deepEqual((await archiveListings(db, { dryRun: true })).archived.map((p) => p.id), [oldDiscovered]);
  assert.ok(fresh > oldArchived);
  store.close();
});

test("discovery's first status entry does not count as removed by cleanup", async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const add = async (/** @type {string} */ stage) => {
    const id = await insert(db, { title: 'x', stage });
    await db.prepare("UPDATE postings SET company = 'Example Co', title = 'CTO', company_title_key = 'example|chief technology officer' WHERE id = ?").run(id);
    await db.prepare("INSERT INTO status_history (user_id, posting_id, from_status, to_status, changed_by, changed_at) VALUES (1, ?, NULL, 'new', 'agent', 'x')").run(id);
    return id;
  };
  const older = await add('discovered');
  const fresh = await add('pipeline');
  assert.deepEqual((await archiveListings(db, { dryRun: true })).archived.map((p) => p.id), [older], 'the pipeline copy is kept');
  assert.ok(fresh);
  store.close();
});

test('copies already archived as duplicates are not pointed out again', async () => {
  const { updatePosting, getPosting } = await import('../server/queries.ts');
  const store = openJobStore(':memory:');
  const { db } = store;
  const add = async (/** @type {{ stage?: string, status?: string }} */ o) => {
    const id = await insert(db, { title: 'x', ...o });
    await db.prepare("UPDATE postings SET company = 'Example Co', title = 'CTO', company_title_key = 'example|chief technology officer' WHERE id = ?").run(id);
    return id;
  };
  const kept = await add({ stage: 'pipeline' });
  const copy = await add({ stage: 'discovered' });
  assert.equal((await listPostings(db, {})).find((r) => r.id === kept)?.hasCopies, true);
  await updatePosting(db, copy, { duplicateOf: kept });
  assert.equal((await listPostings(db, {})).find((r) => r.id === kept)?.hasCopies, false);
  assert.deepEqual((await getPosting(db, kept))?.copies, []);
  const passedEarlier = await add({ stage: 'archived', status: 'passed' });
  await db.prepare("INSERT INTO status_history (user_id, posting_id, from_status, to_status, changed_by, changed_at) VALUES (1, ?, 'new', 'passed', 'user', 'x')").run(passedEarlier);
  assert.deepEqual((await getPosting(db, kept))?.copies.map((c) => c.id), [passedEarlier], 'a copy the user passed on is shown');
  store.close();
});

test('discoveredAfter keeps jobs found on or after the date', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const on = async (/** @type {string} */ day) => {
    const id = await insert(db, { title: `Job ${day}` });
    await db.prepare('UPDATE postings SET discovered_on = ? WHERE id = ?').run(day, id);
    return id;
  };
  await on('2026-09-20');
  const sameDay = await on('2026-09-25');
  const later = await on('2026-10-01');
  assert.deepEqual((await listPostings(db, { discoveredAfter: '2026-09-25' })).map((r) => r.id).sort(), [sameDay, later].sort());
  assert.equal((await listPostings(db, { discoveredAfter: '' })).length, 3, 'empty means no filter');
  store.close();
});
