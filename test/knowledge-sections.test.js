// The knowledge doc's seven sections (agents/knowledge-sections.js) stay in step with the prompts that name them by
// number, the template, the draft builder, the demo's sample, and every example in Help.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KNOWLEDGE_SECTIONS, knowledgeTemplate, sectionCheck } from '../agents/knowledge-sections.js';
import { DRAFT_SYSTEM } from '../agents/draft-profile.js';
import { defaultPrompt } from '../agents/prompts.js';
import { DEMO_ABOUT_YOU } from '../demo/sample-data.js';
import { repoPath } from '../tools/paths.js';

const all = (text) => sectionCheck(text).every((s) => s.found);
const byTitle = (t) => KNOWLEDGE_SECTIONS.find((s) => s.title === t);

test('the section numbers are the ones the default prompts name', () => {
  assert.equal(byTitle('Job Targets').n, 5);
  assert.equal(byTitle('Cover Letter Rules').n, 6);
  assert.match(defaultPrompt('score').template, /Section 5: Job Targets/);
  assert.match(defaultPrompt('cover-letter').template, /Section 6 \(Cover Letter Rules\)/);
  assert.match(defaultPrompt('cover-letter').template, /positioning from Section 5/);
});

test('sectionCheck finds headings written several ways, and only headings', () => {
  const found = (text) => sectionCheck(text).filter((s) => s.found).map((s) => s.n);
  assert.deepEqual(found('## 5. Job Targets\nRoles'), [5]);
  assert.deepEqual(found('Section 6: Cover Letter Rules\n- short'), [6]);
  assert.deepEqual(found('# Summary\nText\n**Strengths**'), [1, 3], 'a bold line on its own counts as a heading');
  assert.deepEqual(found('### 2) Experience'), [2]);
  assert.deepEqual(found('I list my job targets and strengths in this sentence.'), [], 'words inside a sentence do not count');
});

test('the template, the draft builder, the demo, and every example in Help have all seven sections', () => {
  assert.ok(all(knowledgeTemplate()), 'template');
  for (const s of KNOWLEDGE_SECTIONS) assert.ok(DRAFT_SYSTEM.includes(`## ${s.n}. ${s.title}`), `draft builder: ${s.title}`);
  assert.ok(all(DEMO_ABOUT_YOU), 'demo');
  assert.ok(DEMO_ABOUT_YOU.length > 2000, 'the demo is a full example');
  const help = readFileSync(repoPath('help', 'about-you.md'), 'utf8');
  const blocks = [...help.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 4, 'the template and at least three examples');
  for (const [i, b] of blocks.entries()) assert.ok(all(b), `Help block ${i + 1} has every section`);
});
