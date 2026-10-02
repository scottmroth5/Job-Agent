import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefilter, domainOf, domainIn } from '../agents/inbox/prefilter.js';
import { parseAtsEmail, trimBody } from '../agents/inbox/atsParse.js';
import { makeEvent, createEmitter } from '../agents/inbox/events.js';
import { loadInboxConfig } from '../agents/inbox/config.js';

// Synthetic addresses and companies only.
const ats = loadInboxConfig().atsDomains;
const ctx = (o = {}) => ({ threadStartedByMe: false, isContact: () => false, isCompanyDomain: () => false, atsDomains: ats, ...o });
const mail = (from) => ({ senderEmail: from, senderDomain: domainOf(from) });

test('domainOf and domainIn handle display names and subdomains', () => {
  assert.equal(domainOf('Example Recruiting <jobs@Mail.Example.com>'), 'mail.example.com');
  assert.equal(domainOf('not an address'), '');
  assert.ok(domainIn('us.greenhouse.io', ats));
  assert.ok(domainIn('greenhouse.io', ats));
  assert.ok(!domainIn('notgreenhouse.io', ats));
});

test('prefilter passes my threads, contacts, company domains, and ATS domains, in that order', () => {
  assert.deepEqual(prefilter(mail('anyone@random.example'), ctx({ threadStartedByMe: true })), { pass: true, reason: 'my_thread' });
  assert.deepEqual(prefilter(mail('pat@agency.example'), ctx({ isContact: (e) => e === 'pat@agency.example' })), { pass: true, reason: 'contact' });
  assert.deepEqual(prefilter(mail('talent@example.com'), ctx({ isCompanyDomain: (d) => d === 'example.com' })), { pass: true, reason: 'company_domain' });
  assert.deepEqual(prefilter(mail('no-reply@us.greenhouse.io'), ctx()), { pass: true, reason: 'ats_domain' });
  assert.deepEqual(prefilter(mail('jobs-noreply@linkedin.com'), ctx()), { pass: true, reason: 'ats_domain' });
});

test('prefilter skips newsletters and unknown senders', () => {
  assert.deepEqual(prefilter(mail('news@newsletter.example'), ctx()), { pass: false, reason: null });
  assert.deepEqual(prefilter(mail('deals@shop.example'), ctx()), { pass: false, reason: null });
});

test('ATS subjects give company and title', () => {
  const cases = [
    ['Thank you for applying to Example Co', { company: 'Example Co', title: null }],
    ['Thanks for applying to Example Co!', { company: 'Example Co', title: null }],
    ['Your application for VP of Engineering at Example Co', { company: 'Example Co', title: 'VP of Engineering' }],
    ['Application for Director of Engineering at Example Health', { company: 'Example Health', title: 'Director of Engineering' }],
    ['Thank you for your interest in the Head of Engineering position at Sample Labs', { company: 'Sample Labs', title: 'Head of Engineering' }],
    ['Pat, your application was sent to Example Co', { company: 'Example Co', title: null }],
    ['Example Co - Application Received', { company: 'Example Co', title: null }],
    ['Sample Labs | Thank you for applying', { company: 'Sample Labs', title: null }],
    ['Update on your application to Example Co', { company: 'Example Co', title: null }],
    ['Update on your Engineering Manager application', { company: null, title: 'Engineering Manager' }],
    ['Important information about your application to Sample Labs', { company: 'Sample Labs', title: null }],
  ];
  for (const [subject, expected] of cases) assert.deepEqual(parseAtsEmail({ subject }), expected, subject);
});

test('the body is used when the subject says nothing; unrecognized mail gives null', () => {
  assert.deepEqual(parseAtsEmail({ subject: 'Next steps', body: 'Thank you for applying for the Director of Platform role at Example Co. We will review.' }), {
    company: 'Example Co',
    title: 'Director of Platform',
  });
  assert.equal(parseAtsEmail({ subject: 'Weekly digest', body: 'Top stories this week' }), null);
});

test('trimBody converts HTML, drops quoted replies and signatures, and caps the length', () => {
  assert.equal(trimBody('<p>Hi Pat,</p><p>We would like to talk.</p>', { html: true }).replace(/\s+/g, ' '), 'Hi Pat, We would like to talk.');
  const reply = 'Sounds good.\n\nOn Mon, Sep 1, 2026 at 9:00 AM Recruiter <r@example.com> wrote:\n> earlier text';
  assert.equal(trimBody(reply), 'Sounds good.');
  assert.equal(trimBody('Body\n-- \nSignature line'), 'Body');
  assert.equal(trimBody('x'.repeat(50), { max: 10 }), `${'x'.repeat(10)}\n[trimmed]`);
});

test('events carry IDs only, and the emitter counts them', () => {
  const emitter = createEmitter();
  const seen = [];
  emitter.on('email.matched', (e) => seen.push(e));
  emitter.emit(makeEvent('email.received', { emailId: 'e1' }));
  emitter.emit(makeEvent('email.matched', { emailId: 'e1', postingId: 7, rule: 'thread' }));
  assert.deepEqual(Object.keys(seen[0]).sort(), ['at', 'emailId', 'id', 'postingId', 'rule', 'type']);
  assert.deepEqual(emitter.counts(), { 'email.received': 1, 'email.matched': 1, 'email.needs_review': 0 });
  assert.throws(() => makeEvent('email.deleted', { emailId: 'e1' }), /Unknown/);
});
