import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { storedKey } from '../agents/identity.js';
import { matchEmail, listOpenApplications } from '../agents/inbox/match.js';
import { loadInboxConfig } from '../agents/inbox/config.js';

const atsDomains = loadInboxConfig().atsDomains;
const now = '2026-10-02T00:00:00Z';

function app(db, company, title, o = {}) {
  const row = { status: 'applied', stage: 'pipeline', company_domain: null, ...o };
  return Number(
    db
      .prepare(`INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, stage, status, company_domain, created_at, updated_at)
        VALUES (?, ?, ?, ?, '2026-09-01', ?, ?, ?, ?, ?)`)
      .run(`k${Math.random()}`, company, title, storedKey({ company, title }), row.stage, row.status, row.company_domain, now, now).lastInsertRowid,
  );
}

const email = (o) => ({ threadId: 't-new', senderEmail: 'someone@unknown.example', senderDomain: 'unknown.example', subject: '', body: '', ...o });

function setup() {
  const store = openJobStore(':memory:');
  const { db } = store;
  const ids = {
    acme: app(db, 'Example Co', 'VP of Engineering', { company_domain: 'example.com' }),
    sample: app(db, 'Sample Labs', 'Director of Engineering'),
    sample2: app(db, 'Sample Labs', 'Head of Platform'),
    passed: app(db, 'Old Corp', 'CTO', { status: 'passed', stage: 'archived' }),
    archivedApplied: app(db, 'Archived Applied Inc', 'Engineering Manager', { stage: 'archived' }),
  };
  return { store, db, ids };
}

test('open applications include archived applied jobs but not passed ones', () => {
  const { store, db, ids } = setup();
  const open = listOpenApplications(db).map((a) => a.id);
  assert.ok(open.includes(ids.archivedApplied));
  assert.ok(!open.includes(ids.passed));
  store.close();
});

test('rule 1: a known thread', () => {
  const { store, db, ids } = setup();
  db.prepare("INSERT INTO email_threads (thread_id, posting_id, kind, created_at) VALUES ('t-1', ?, 'application', ?)").run(ids.sample, now);
  assert.deepEqual(matchEmail(db, email({ threadId: 't-1' }), { atsDomains }), { postingId: ids.sample, rule: 'thread' });
  store.close();
});

test('rule 2: a known contact (case-insensitive)', () => {
  const { store, db, ids } = setup();
  db.prepare("INSERT INTO contacts (id, email, posting_id, source, created_at, updated_at) VALUES ('c1', 'recruiter@agency.example', ?, 'email', ?, ?)").run(ids.sample2, now, now);
  assert.deepEqual(matchEmail(db, email({ senderEmail: 'Recruiter@Agency.example' }), { atsDomains }), { postingId: ids.sample2, rule: 'contact' });
  store.close();
});

test('rule 3: the company domain of exactly one open application, never an ATS domain', () => {
  const { store, db, ids } = setup();
  assert.deepEqual(matchEmail(db, email({ senderDomain: 'talent.example.com' }), { atsDomains }), { postingId: ids.acme, rule: 'domain' });
  app(db, 'Example Co', 'Director of Data', { company_domain: 'example.com' });
  assert.equal(matchEmail(db, email({ senderDomain: 'example.com' }), { atsDomains }), null, 'two open applications at that domain');
  db.prepare("UPDATE postings SET company_domain = 'greenhouse.io' WHERE id = ?").run(ids.sample);
  assert.equal(matchEmail(db, email({ senderDomain: 'greenhouse.io' }), { atsDomains }), null);
  store.close();
});

test('rule 4: ATS subject parsing, by company and title or by company alone', () => {
  const { store, db, ids } = setup();
  const ats = (subject) => matchEmail(db, email({ senderDomain: 'greenhouse.io', subject }), { atsDomains });
  assert.deepEqual(ats('Your application for VP Engineering at Example Co, Inc.'), { postingId: ids.acme, rule: 'ats_subject' });
  assert.deepEqual(ats('Your application for Director of Engineering at Sample Labs'), { postingId: ids.sample, rule: 'ats_subject' });
  assert.equal(ats('Thank you for applying to Sample Labs'), null, 'two open Sample Labs applications');
  assert.deepEqual(ats('Thank you for applying to Archived Applied Inc'), { postingId: ids.archivedApplied, rule: 'ats_subject' });
  assert.equal(ats('Thank you for applying to Old Corp'), null, 'passed jobs are not open');
  store.close();
});

test('the cascade stops at the first rule that matches, and returns null for the model to try', () => {
  const { store, db, ids } = setup();
  db.prepare("INSERT INTO email_threads (thread_id, posting_id, kind, created_at) VALUES ('t-2', ?, 'application', ?)").run(ids.sample, now);
  const both = email({ threadId: 't-2', senderDomain: 'example.com', subject: 'Thank you for applying to Example Co' });
  assert.deepEqual(matchEmail(db, both, { atsDomains }), { postingId: ids.sample, rule: 'thread' });
  assert.equal(matchEmail(db, email({ subject: 'Quick question about your background' }), { atsDomains }), null);
  store.close();
});
