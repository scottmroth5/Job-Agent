// scripts/engine-parity.js compare: how two engines' answers are judged (v3 Phase 4). Synthetic values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare } from '../scripts/engine-parity.js';

test('equal answers match, whatever their key order, and a float differing in its last bits still matches', () => {
  assert.equal(compare('x', { a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }).result, 'match');
  assert.equal(compare('x', { avg: 0.1 + 0.2 }, { avg: 0.3 }).result, 'match');
  assert.equal(compare('x', { file: Buffer.from('ab') }, { file: new Uint8Array([97, 98]) }).result, 'match', 'a Buffer and its bytes');
});

test('the same items in a different order, at any depth, are told apart from a real difference', () => {
  assert.equal(compare('x', [1, 2, 3], [3, 1, 2]).result, 'order');
  assert.equal(compare('x', { list: [{ id: 1 }, { id: 2 }] }, { list: [{ id: 2 }, { id: 1 }] }).result, 'order');
  assert.equal(compare('x', [1, 2, 3], [1, 2, 4]).result, 'differ');
  assert.equal(compare('x', { list: [1, 2] }, { list: [1, 2, 2] }).result, 'differ', 'a repeated item is a difference');
  assert.equal(compare('x', { n: 1 }, { n: '1' }).result, 'differ', 'a number and its text are different');
});

test('the item count is what was compared', () => {
  assert.equal(compare('x', [1, 2, 3], [1, 2, 3]).items, 3);
  assert.equal(compare('x', { a: 1, b: 2 }, { a: 1, b: 2 }).items, 2);
});
