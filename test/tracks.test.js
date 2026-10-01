import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRate, parseHours, annualize } from '../tools/rates.js';
import { detectTrack } from '../tools/track.js';
import { openJobStore } from '../db/index.js';

test('parseRate reads the formats fractional boards use', () => {
  assert.deepEqual(parseRate('$5K - $6K / mo'), { min: 5000, max: 6000, unit: 'month' });
  assert.deepEqual(parseRate('Est. $175 to $225/hr'), { min: 175, max: 225, unit: 'hour' });
  assert.deepEqual(parseRate('$10K to $20K/mo'), { min: 10000, max: 20000, unit: 'month' });
  assert.deepEqual(parseRate('$200k - $250k'), { min: 200000, max: 250000, unit: 'year' });
  assert.deepEqual(parseRate('$150 to $300/hr'), { min: 150, max: 300, unit: 'hour' });
  assert.deepEqual(parseRate('$150/hour'), { min: 150, max: 150, unit: 'hour' });
  assert.deepEqual(parseRate('$5K - 6K per month'), { min: 5000, max: 6000, unit: 'month' });
  assert.deepEqual(parseRate('$180,000 - $210,000'), { min: 180000, max: 210000, unit: 'year' });
  assert.equal(parseRate('Competitive'), null);
});

test('parseHours reads the first number or range', () => {
  assert.deepEqual(parseHours('5 - 8 hrs'), { min: 5, max: 8 });
  assert.deepEqual(parseHours('8 to 15 (10 to 20 to start)'), { min: 8, max: 15 });
  assert.deepEqual(parseHours('20 hours/week'), { min: 20, max: 20 });
  assert.deepEqual(parseHours('10 to 25'), { min: 10, max: 25 });
  assert.equal(parseHours('Flexible'), null);
  assert.equal(parseHours('500 hrs'), null);
});

test('annualize matches the tracker math', () => {
  // Two engagements at 15 hrs/week and $200/hr over 48 weeks is about $288K: one is $144K.
  assert.deepEqual(annualize({ min: 200, max: 200, unit: 'hour' }, { min: 15, max: 15 }), { low: 144000, mid: 144000, high: 144000 });
  assert.deepEqual(annualize({ min: 10000, max: 20000, unit: 'month' }, null), { low: 120000, mid: 180000, high: 240000 });
  assert.deepEqual(annualize({ min: 175, max: 225, unit: 'hour' }, { min: 8, max: 15 }, 48).low, 67200);
  assert.equal(annualize({ min: 175, max: 225, unit: 'hour' }, null), null);
  assert.equal(annualize(null, null), null);
});

test('detectTrack', () => {
  assert.equal(detectTrack({ source: 'Fractional Jobs', title: 'CTO' }), 'fractional');
  assert.equal(detectTrack({ source: 'LinkedIn', searchTrack: 'fractional', title: 'CTO' }), 'fractional');
  assert.equal(detectTrack({ source: 'LinkedIn', title: 'Interim VP Engineering' }), 'fractional');
  assert.equal(detectTrack({ source: 'manual', title: 'CTO', description: 'We need a fractional CTO for 10 hours.' }), 'fractional');
  assert.equal(detectTrack({ source: 'Himalayas', title: 'CTO', hoursMax: 20 }), 'fractional');
  assert.equal(detectTrack({ source: 'Himalayas', title: 'VP Engineering', description: 'Full-time role.' }), 'fulltime');
});

test('005 migration adds track, rate and hours columns defaulting to full-time', () => {
  const store = openJobStore(':memory:');
  const cols = store.db.prepare('PRAGMA table_info(postings)').all().map((c) => c.name);
  for (const c of ['track', 'rate_text', 'rate_min', 'rate_max', 'rate_unit', 'hours_min', 'hours_max', 'extra_json']) assert.ok(cols.includes(c), c);
  store.close();
});

test('findPayInText finds a salary or an explicit hourly range, and skips funding figures', async () => {
  const { findPayInText } = await import('../tools/rates.js');
  assert.deepEqual(findPayInText('The base salary range is $170,000 - $210,000 plus equity.'), { min: 170000, max: 210000, unit: 'year', text: '$170,000 - $210,000' });
  assert.equal(findPayInText('Pay: $150K–$200K per year').max, 200000);
  assert.deepEqual(findPayInText('Contract at $80 to $95/hr').unit, 'hour');
  assert.equal(findPayInText('We raised $50 - $100 million and offer a $1,000 - $2,000 stipend.'), null);
  assert.equal(findPayInText('Hourly-looking $50 - $90 with no unit'), null);
  assert.equal(findPayInText(''), null);
});

test('parseRate applies a k on one side of a range to both', () => {
  assert.deepEqual(parseRate('$10-20k/month'), { min: 10000, max: 20000, unit: 'month' });
  assert.deepEqual(parseRate('$5K - 6K / mo'), { min: 5000, max: 6000, unit: 'month' });
  assert.deepEqual(parseRate('$175 to $225/hr'), { min: 175, max: 225, unit: 'hour' });
  assert.deepEqual(parseRate('$175,000 - 185,000'), { min: 175000, max: 185000, unit: 'year' });
});
