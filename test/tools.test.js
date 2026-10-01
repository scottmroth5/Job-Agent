import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeUrl, companyTitleKey } from '../tools/urls.js';
import { parseSheetDate, parsePostedDate } from '../tools/dates.js';
import { fillTemplate } from '../tools/template.js';
import { loadConfig, validateConfig, homeAreaText } from '../tools/config.js';

test('normalizeUrl drops tracking, fragments, www and trailing slashes', () => {
  assert.equal(
    normalizeUrl('https://WWW.Example.com/jobs/123/?utm_source=x&b=2&a=1#apply'),
    'example.com/jobs/123?a=1&b=2',
  );
  assert.equal(normalizeUrl('https://boards.example.io/acme/jobs/9?gh_src=abc'), 'boards.example.io/acme/jobs/9');
  assert.equal(normalizeUrl('  '), null);
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

test('normalizeUrl reduces LinkedIn job links to the job ID', () => {
  const key = 'linkedin.com/jobs/view/4000000123';
  assert.equal(normalizeUrl('https://www.linkedin.com/jobs/view/VP-Engineering-at-Acme-4000000123/?refId=x&trackingId=y'), key);
  assert.equal(normalizeUrl('https://linkedin.com/jobs/view/4000000123'), key);
  assert.equal(normalizeUrl('https://www.linkedin.com/company/acme/'), 'linkedin.com/company/acme');
});

test('companyTitleKey ignores case, punctuation and spacing', () => {
  assert.equal(companyTitleKey('Acme, Inc.', 'VP  of Engineering'), companyTitleKey('acme inc', 'vp of engineering'));
  assert.equal(companyTitleKey('Example Co', 'Vice President of Engineering'), companyTitleKey('Example', 'VP Engineering'));
  assert.equal(companyTitleKey('M3 USA', 'Vice President, Technology and Product (Remote)'), companyTitleKey('M3USA', 'VP Technology & Product'));
  assert.equal(companyTitleKey('Example LLC', 'Sr. Engineering Mgr'), companyTitleKey('Example', 'Senior Engineering Manager'));
  assert.notEqual(companyTitleKey('Example', 'Director of Engineering'), companyTitleKey('Example', 'Senior Director of Engineering'));
  assert.notEqual(companyTitleKey('Example One', 'CTO'), companyTitleKey('Example Two', 'CTO'));
  assert.equal(companyTitleKey('Co', 'CTO'), 'co|chief technology officer', 'a name made only of a suffix is kept');
});

test('parseSheetDate handles M/D/YYYY and ISO, rejects impossible dates', () => {
  assert.equal(parseSheetDate('6/26/2026'), '2026-06-26');
  assert.equal(parseSheetDate('2026-09-01T10:00:00Z'), '2026-09-01');
  assert.equal(parseSheetDate('2/30/2026'), null);
  assert.equal(parseSheetDate(''), null);
});

test('parsePostedDate resolves relative values from the discovery date', () => {
  assert.equal(parsePostedDate('7/13/2026', '7/20/2026'), '2026-07-13');
  assert.equal(parsePostedDate('16 hours ago', '7/20/2026'), '2026-07-20');
  assert.equal(parsePostedDate('36 hours ago', '7/20/2026'), '2026-07-19');
  assert.equal(parsePostedDate('3 days ago', '7/2/2026'), '2026-06-29');
  assert.equal(parsePostedDate('2 weeks ago', '7/20/2026'), '2026-07-06');
  assert.equal(parsePostedDate('Recent', '7/20/2026'), '2026-07-20');
  assert.equal(parsePostedDate('sometime', '7/20/2026'), null);
});

test('fillTemplate keeps $ values and rejects unfilled placeholders', () => {
  assert.equal(fillTemplate('Pay {{pay}} at {{co}} ({{co}})', { pay: '$200k', co: 'Acme' }), 'Pay $200k at Acme (Acme)');
  assert.throws(() => fillTemplate('Hi {{name}} {{missing}}', { name: 'x' }), /Unfilled template placeholders: \{\{missing\}\}/);
});

const validConfig = () => ({
  candidate: { name: 'Pat Example', signoffName: 'Pat', contactLine: 'Anytown | pat@example.com', linkedin: 'linkedin.com/in/example' },
  search: {
    terms: ['VP Engineering'],
    relevantTitleKeywords: ['engineering'],
    noiseTitleKeywords: ['intern'],
    homeLocations: ['Anytown'],
  },
  coverLetterChecks: [{ label: 'weak closer', text: '\\bi am ready\\b' }, { label: 'pair', sentence: ['a', 'b'] }],
  privateTerms: ['Pat Example'],
  allowTerms: ['example-user'],
});

test('validateConfig accepts a complete config and names each problem', () => {
  assert.deepEqual(validateConfig(validConfig()), []);
  const bad = validConfig();
  bad.candidate.name = '';
  bad.search.terms = [];
  bad.coverLetterChecks = [{ label: 'x', text: '(' }, { label: 'y', sentence: ['only one'] }];
  bad.privateTerms = 'nope';
  const problems = validateConfig(bad);
  assert.ok(problems.some((p) => p.includes('candidate.name')));
  assert.ok(problems.some((p) => p.includes('search.terms')));
  assert.ok(problems.some((p) => p.includes('invalid pattern')));
  assert.ok(problems.some((p) => p.includes('two-item')));
  assert.ok(problems.some((p) => p.includes('privateTerms')));
});

test('homeAreaText prefers the label and falls back to the location list', () => {
  const config = validConfig();
  assert.equal(homeAreaText(config), 'Anytown');
  config.search.homeLocations = ['Anytown, ST', 'Suburb, ST'];
  assert.equal(homeAreaText(config), 'Anytown, ST or Suburb, ST');
  config.search.homeAreaLabel = 'the Anytown area';
  assert.equal(homeAreaText(config), 'the Anytown area');
  assert.deepEqual(validateConfig(config), []);
  config.search.homeAreaLabel = '  ';
  assert.ok(validateConfig(config).some((p) => p.includes('homeAreaLabel')));
});

test('loadConfig explains a missing or invalid file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-agent-'));
  try {
    assert.throws(() => loadConfig(join(dir, 'none.json')), /config:from-v1/);
    const path = join(dir, 'c.json');
    writeFileSync(path, JSON.stringify(validConfig()));
    assert.equal(loadConfig(path).candidate.name, 'Pat Example');
    writeFileSync(path, '{ not json');
    assert.throws(() => loadConfig(path), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
