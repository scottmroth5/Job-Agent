import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPersonalHits, maskTerm, envValues, isForbiddenPath } from '../scripts/check-personal.js';
import { buildConfig } from '../scripts/config-from-v1.js';
import { validateConfig } from '../tools/config.js';
import { repoPath } from '../tools/paths.js';

test('finds private terms case-insensitively, as whole words, with line numbers', () => {
  const text = 'line one\nWritten by Pat EXAMPLE\nbrother of nobody\nemail pat@example.com here';
  const hits = findPersonalHits(text, ['pat example', 'other', 'pat@example.com']);
  assert.deepEqual(hits, [
    { line: 2, term: 0 },
    { line: 4, term: 2 },
  ]);
});

test('allowTerms hide a public handle that contains a private word', () => {
  const text = '"name": "@patexample7/agent-core"\nPat said hi';
  assert.deepEqual(findPersonalHits(text, ['pat'], ['patexample7']), [{ line: 2, term: 0 }]);
  assert.deepEqual(findPersonalHits('patexample7', ['patexample'], ['patexample7']), []);
});

test('catches a planted secret from .env values', () => {
  const env = 'ANTHROPIC_API_KEY=sk-test-0123456789abcdef\nFLAG=1\nQUOTED="some-long-value-here"\n# comment';
  const terms = envValues(env);
  assert.deepEqual(terms, ['sk-test-0123456789abcdef', 'some-long-value-here']);
  assert.equal(findPersonalHits('const key = "sk-test-0123456789abcdef";', terms).length, 1);
});

test('personal-data locations are refused regardless of .gitignore', () => {
  for (const f of ['data/config/job-search.json', 'data/job-agent.db', '.env', '.env.local', 'server/.env']) assert.ok(isForbiddenPath(f), f);
  for (const f of ['db/index.js', 'tools/data.js', 'config/job-search.example.json', 'docs/env.md']) assert.ok(!isForbiddenPath(f), f);
});

test('masks terms so a secret is never printed in full', () => {
  assert.equal(maskTerm('sk-test-0123456789abcdef'), 'sk***f (24 chars)');
  assert.equal(maskTerm('abc'), 'a***');
});

test('buildConfig maps v1 properties and seeds privateTerms', () => {
  const config = buildConfig({
    CONTACT_NAME: 'Pat Example',
    CONTACT_LINE: 'Anytown, ST | pat@example.com | 555-0100',
    CONTACT_LINKEDIN: 'linkedin.com/in/example',
    EMAIL_ADDRESS: 'pat@example.com',
    SEARCH_TERMS: 'VP Engineering, Head of Engineering',
    RELEVANT_TITLE_KEYWORDS: 'engineering, cto',
    NOISE_TITLE_KEYWORDS: '',
    HOME_LOCATIONS: 'Anytown',
    COVER_LETTER_CHECKS: JSON.stringify([
      { label: 'wrong title', sentence: ['globex|initech', '\\bCTO\\b'] },
      { label: 'weak', text: '\\bi am ready\\b' },
    ]),
    YOUR_KNOWLEDGE_DOC_ID: 'doc-id-0123456789',
  });
  assert.equal(config.candidate.signoffName, 'Pat Example');
  assert.deepEqual(config.search.terms, ['VP Engineering', 'Head of Engineering']);
  assert.deepEqual(config.search.noiseTitleKeywords, []);
  assert.equal(config.coverLetterChecks.length, 2);
  for (const t of ['pat example', 'example', 'anytown', 'pat@example.com', 'globex', 'initech', 'doc-id-0123456789']) {
    assert.ok(config.privateTerms.includes(t), t);
  }
  assert.deepEqual(validateConfig(config), []);
});

test('the committed example config is valid', () => {
  const example = JSON.parse(readFileSync(repoPath('config', 'job-search.example.json'), 'utf8'));
  assert.deepEqual(validateConfig(example), []);
});
