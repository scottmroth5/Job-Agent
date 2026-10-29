// The demo's canned AI answers (demo/samples.js): shaped like the real ones and held to the same rules, so the demo
// reads like the app. They use only the fictional candidate's facts and call no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { samplePrep, sampleLetter, sampleTweaks, sampleScore, sampleRevision, sampleHelpAnswer, sampleDraft } from '../demo/samples.js';
import { DEMO_CONFIG, JOBS } from '../demo/sample-data.js';
import { validateDraft } from '../agents/draft-profile.js';
import { finishLetter } from '../agents/hunt/generate.js';
import { sectionCheck } from '../agents/knowledge-sections.js';

const job = { company: JOBS[0].company, title: JOBS[0].title, score: 9, analysis: { reason: 'Strong match.', strengths: ['Scaled a platform team'], watchOuts: ['Team is offshore'] } };

test('the sample prep has the real prompt\'s ten sections, for the people the visitor entered', () => {
  const md = samplePrep(job, { attendees: [{ name: 'Dana Ortiz', role: 'CEO' }], kind: 'Recruiter or search firm', format: 'Video' });
  assert.ok(md.startsWith(`# Call Prep: Dana Ortiz, ${job.company}`));
  const sections = md.match(/^## .+$/gm).map((h) => h.slice(3));
  assert.deepEqual(sections, ['The Meeting at a Glance', 'Who You Are Talking To', 'Company Snapshot', 'Your Opening', 'Fit Against the Role', 'Stories to Have Ready', 'Likely Questions and Your Answers', 'Gaps: Own Them, Then Bridge', 'Questions to Ask', 'Close and Next Steps']);
  assert.match(md, /What are you looking for in pay/, 'a recruiter screen covers pay');
  assert.match(md, /Team is offshore/, 'gaps come from the fit analysis');
  assert.ok(!/[—–]/.test(md), 'no dashes, like the real prompt');
  assert.ok(samplePrep(job, {}).includes('Morgan Lee'), 'nobody entered: a likely hiring manager');
});

test('sample letters pass the real letter rules, and each kind of revision does what it says', () => {
  for (const letter of [sampleLetter(job), sampleLetter(job, { regenerate: true })]) {
    const { body, flags } = finishLetter(letter, DEMO_CONFIG);
    assert.equal(body, letter.trim(), 'nothing for the cleanup to change');
    assert.deepEqual(flags, [], 'no letter check fires and it is under the word limit');
  }
  assert.notEqual(sampleLetter(job).split('\n')[0], sampleLetter(job, { regenerate: true }).split('\n')[0], 'Regenerate opens differently');
  assert.match(sampleTweaks(job), /^Summary:/);
  assert.deepEqual([sampleScore(job).score, sampleScore(job).reason], [9, 'Strong match.']);

  const letter = sampleLetter(job);
  const words = (t) => t.split(/\s+/).length;
  const short = sampleRevision({ letter, feedback: 'make it shorter', company: job.company, title: job.title });
  assert.ok(words(short.letter) < words(letter) && short.changes.endsWith(`from ${words(letter)} words to ${words(short.letter)}.`), short.changes);
  assert.match(sampleRevision({ letter, feedback: 'warmer please', company: job.company, title: job.title }).letter, /Thank you for considering me\.$/);
  assert.match(sampleRevision({ letter, feedback: 'lead with a result', company: job.company, title: job.title }).letter, /^I have spent eight years/);
  assert.match(sampleRevision({ letter, feedback: 'mention distributed teams', company: job.company, title: job.title }).letter, /Poland, and Colombia/);
  const other = sampleRevision({ letter, feedback: 'mention the board', company: job.company, title: job.title });
  assert.match(other.changes, /only knows a few requests/, 'an unknown request says what the sample can do instead of pretending');
  for (const r of [short, other]) assert.deepEqual(finishLetter(r.letter, DEMO_CONFIG).flags, []);
});

test('the sample Help answer quotes the guide section that matches the question', () => {
  const guides = readdirSync('help').map((f) => ({ title: /^#\s+(.+)$/m.exec(readFileSync(`help/${f}`, 'utf8'))[1], markdown: readFileSync(`help/${f}`, 'utf8') }));
  assert.match(sampleHelpAnswer('How do I skip a job site?', guides).answer, /Job sites to skip/);
  assert.match(sampleHelpAnswer('When is an application stale?', guides).answer, /Following up on applications/);
  assert.match(sampleHelpAnswer('zzzz qqqq', guides).answer, /do not cover that yet/);
});

test('the sample draft is a valid draft with all seven knowledge doc sections and questions to answer', () => {
  const d = sampleDraft();
  assert.deepEqual(validateDraft(d).search.terms, DEMO_CONFIG.search.terms);
  assert.ok(sectionCheck(d.aboutYou).every((s) => s.found));
  assert.equal(d.questions.length, 3);
});
