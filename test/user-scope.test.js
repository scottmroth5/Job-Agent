// Multi-user guard (phase 1): every SQL statement in the code that reads or writes a user table names user_id, so it is
// scoped to one user (db/scope.ts binds @uid). Only server/admin-queries.ts and the migrations may query across users.
// A false alarm (a string that only looks like SQL) is fixed by rewording the string, never by an exemption here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USER_TABLES } from '../db/user-tables.ts';
import { appSources, stringLiterals } from './fixtures/sql-literals.js';

// Migrations shape every user's rows at once; admin queries are the reviewed cross-user reads.
const isExempt = (/** @type {string} */ rel) => rel.startsWith('db/migrations/') || rel === 'server/admin-queries.ts';

// runs and run_calls (agent-core's) stay app-wide in phase 1; the Activity tab and spending become per user with phase 2.
const tableRef = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+"?(${USER_TABLES.join('|')})\\b`, 'gi');

// Each user table a statement reads or writes needs its own user_id condition (a subquery or join too), so a statement
// names user_id at least as often as it names user tables: "FROM a JOIN b ON b.a_id = a.id" also says b.user_id = a.user_id.
test('every query on a user table names user_id once per user table (except admin queries and migrations)', () => {
  const misses = [];
  for (const { rel, literals } of appSources()) {
    if (isExempt(rel)) continue;
    for (const lit of literals) {
      if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(lit)) continue;
      const refs = [...lit.matchAll(tableRef)].map((m) => m[2]);
      const scoped = (lit.match(/\buser_id\b/g) ?? []).length;
      if (refs.length && scoped < refs.length) misses.push(`${rel}: ${refs.join('+')} (${scoped} user_id): ${lit.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
  assert.deepEqual(misses, [], `${misses.length} unscoped queries:\n${misses.join('\n')}`);
});

test('the string scanner finds nested template literals whole', () => {
  const lits = stringLiterals("const a = `SELECT ${cols.map((c) => `${c} = 1`).join(', ')} FROM t`; // 'x'\nconst b = 'y';");
  assert.equal(lits.length, 2);
  assert.match(lits[0], /FROM t`$/);
  assert.equal(lits[1], "'y'");
});
