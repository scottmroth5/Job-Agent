// db/engine/sql.ts: the placeholder rewrite and binding the PostgreSQL engine uses (v3 Phase 4). Pure functions, so
// these run on every engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindValues, jsonNumber, numberPlaceholders, returnsId } from '../db/engine/sql.ts';

test('? and @name become $n in order; a repeated @name keeps its number', () => {
  const { text, slots } = numberPlaceholders('SELECT * FROM t WHERE a = ? AND user_id = @uid AND b = @b OR c = @uid AND d = ?');
  assert.equal(text, 'SELECT * FROM t WHERE a = $1 AND user_id = $2 AND b = $3 OR c = $2 AND d = $4');
  assert.deepEqual(slots, [{ kind: 'positional' }, { kind: 'named', name: 'uid' }, { kind: 'named', name: 'b' }, { kind: 'positional' }]);
});

test('placeholders inside strings, quoted names, comments, and dollar quotes are left alone', () => {
  const sql = `SELECT 'a ? b @c', 'it''s ?', "odd?name" FROM t -- why? @x
    WHERE /* @y ? */ a = ? AND b = $$ ? @z $$`;
  const { text, slots } = numberPlaceholders(sql);
  assert.equal(slots.length, 1);
  assert.equal(text, sql.replace('a = ?', 'a = $1'));
});

test('casts and email-like text in strings survive', () => {
  assert.equal(numberPlaceholders("SELECT x::jsonb, 'hr@example.com' FROM t WHERE y = @y").text, "SELECT x::jsonb, 'hr@example.com' FROM t WHERE y = $1");
});

test('values bind like better-sqlite3: positional, one named object, and the errors it gives', () => {
  const { slots } = numberPlaceholders('INSERT INTO t VALUES (@uid, ?, ?, @now)');
  assert.deepEqual(bindValues(slots, ['a', null, { uid: 7, now: 'x' }]), [7, 'a', null, 'x']);
  assert.throws(() => bindValues(slots, ['a', { uid: 7, now: 'x' }]), /Too few/);
  assert.throws(() => bindValues(slots, ['a', 'b', 'c', { uid: 7, now: 'x' }]), /Too many/);
  assert.throws(() => bindValues(slots, ['a', 'b', { uid: 7 }]), /Missing named parameter "now"/);
  assert.deepEqual(bindValues(numberPlaceholders('SELECT ?').slots, [undefined]), [null], 'undefined binds as NULL');
  const buf = Buffer.from('x');
  assert.deepEqual(bindValues(numberPlaceholders('SELECT ?').slots, [buf]), [buf], 'a Buffer is a value, not named values');
});

test('returnsId only for a statement that ends in RETURNING id', () => {
  assert.ok(returnsId('INSERT INTO t (a) VALUES (?) RETURNING id'));
  assert.ok(returnsId('INSERT INTO t (a) VALUES (?)\n  RETURNING id ;'));
  assert.ok(!returnsId('INSERT INTO t (a) VALUES (?)'));
  assert.ok(!returnsId('INSERT INTO t (a) VALUES (?) RETURNING id, a'));
});

test('jsonNumber checks its key and spells the read for each engine', () => {
  assert.throws(() => jsonNumber('sqlite', 'c', "x') OR 1=1 --"), /unsafe key/);
  assert.match(jsonNumber('sqlite', 'ls.a', 'score'), /json_extract\(ls\.a, '\$\.score'\)/);
  assert.match(jsonNumber('postgres', 'ls.a', 'score'), /IS JSON OBJECT THEN CASE WHEN jsonb_typeof/);
});
