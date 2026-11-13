// Portable SQL guard (v3 Phase 4): app SQL runs on SQLite and PostgreSQL, so it may not use syntax only SQLite has.
// db/engine/sql.ts holds the few fragments the dialects spell differently. SQLite-only tools (they read SQLite's own
// catalog or files, and get PostgreSQL versions in Phase 5) are listed by rule, with the reason. A false alarm (a string
// that only looks like SQL) is fixed by rewording the string, never by widening a list here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appSources } from './fixtures/sql-literals.js';

// The SQLite migrations are SQLite's own; PostgreSQL has its own schema files. The engines speak their own dialect.
const isExempt = (/** @type {string} */ rel) => rel.startsWith('db/migrations/') || rel === 'db/engine/sqlite.ts' || rel === 'db/engine/sql.ts';

// Files that work on a SQLite database file itself, until Phase 5 gives them PostgreSQL versions.
const SQLITE_TOOLS = [
  'db/engine/files.ts', // read-only opens, copies, online backups, integrity checks of the SQLite file
  'tools/baseline.ts', // report:baseline reads the file's page counts and catalog
  'tools/backup/restore-check.ts', // the restore test counts rows in a restored SQLite file
  'scripts/db-types.js', // db:types reads column types from SQLite's catalog
];

/** @type {Array<{ name: string, pattern: RegExp, allow?: string[], example: string }>} */
const RULES = [
  { name: 'rowid (PostgreSQL has none; order by a column)', pattern: /\browid\b/i, example: 'SELECT * FROM t ORDER BY rowid' },
  { name: 'IFNULL (use COALESCE)', pattern: /\bIFNULL\s*\(/i, example: "SELECT IFNULL(a, '') FROM t" },
  { name: 'INSERT OR IGNORE/REPLACE (use ON CONFLICT)', pattern: /\bINSERT\s+OR\s+(IGNORE|REPLACE)\b|\bREPLACE\s+INTO\b/i, example: 'INSERT OR IGNORE INTO t (a) VALUES (?)' },
  {
    name: "SQLite date functions (compute the day in code: tools/dates.ts)",
    pattern: /\b(date|datetime|julianday|strftime|unixepoch)\s*\(/i,
    example: "SELECT * FROM t WHERE d >= date('now', '-30 days')",
  },
  { name: 'SQLite JSON functions (db/engine/sql.ts jsonNumber)', pattern: /\bjson_\w+\s*\(/i, example: "SELECT json_extract(a, '$.b') FROM t" },
  { name: 'GROUP_CONCAT, IIF, or TOTAL (SQLite only)', pattern: /\b(GROUP_CONCAT|IIF|TOTAL)\s*\(/i, example: 'SELECT GROUP_CONCAT(a) FROM t' },
  {
    name: "SQLite's catalog (pragma, sqlite_master)",
    pattern: /\bpragma\b|\bsqlite_(master|schema)\b/i,
    allow: [...SQLITE_TOOLS, 'scripts/demo-seed.js'], // isDemoDatabase checks a SQLite file before reseeding it (PGlite in PR 5)
    example: "SELECT name FROM sqlite_master WHERE type = 'table'",
  },
  { name: 'ROUND with places (PostgreSQL has none for double precision)', pattern: /\bROUND\s*\((?:[^()]|\([^()]*\))*,\s*\d+\s*\)/i, allow: SQLITE_TOOLS, example: 'SELECT ROUND(SUM(a), 2) FROM t' },
  { name: 'transaction statements (db.tx)', pattern: /\b(BEGIN\s+(IMMEDIATE|EXCLUSIVE|DEFERRED|TRANSACTION)|SAVEPOINT|RELEASE\s+\w+)\b/i, example: 'BEGIN IMMEDIATE' },
  {
    name: 'unquoted camelCase alias (PostgreSQL lowercases it: write AS "fooBar")',
    pattern: /\bAS\s+[a-z]+[A-Z][A-Za-z0-9]*\b/,
    example: 'SELECT started_at AS startedAt FROM runs',
  },
];

const isSql = (/** @type {string} */ lit) => /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(lit);

test('app SQL uses no SQLite-only syntax (portable to PostgreSQL)', () => {
  const misses = [];
  for (const { rel, literals } of appSources()) {
    if (isExempt(rel)) continue;
    for (const lit of literals.filter(isSql)) {
      for (const rule of RULES) {
        if (rule.allow?.includes(rel)) continue;
        if (rule.pattern.test(lit)) misses.push(`${rel}: ${rule.name}: ${lit.replace(/\s+/g, ' ').slice(0, 110)}`);
      }
    }
  }
  assert.deepEqual(misses, [], `${misses.length} SQLite-only statements:\n${misses.join('\n')}`);
});

test('each rule catches its example, and portable spellings pass', () => {
  for (const rule of RULES) assert.match(rule.example, rule.pattern, rule.name);
  const portable = [
    'SELECT started_at AS "startedAt" FROM runs',
    'INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING',
    "SELECT COALESCE(a, '') FROM t ORDER BY created_at, id",
    'INSERT INTO t (a) VALUES (?) RETURNING id',
    'SELECT * FROM t WHERE lower(title) LIKE lower(@q)',
    'SELECT * FROM postings p WHERE p.discovered_on >= @since',
  ];
  for (const sql of portable) for (const rule of RULES) assert.doesNotMatch(sql, rule.pattern, `${rule.name}: ${sql}`);
});

test('every allowed file exists and still needs at least one of its exceptions', () => {
  const sources = new Map(appSources().map((s) => [s.rel, s.literals.filter(isSql)]));
  const allowed = new Set(RULES.flatMap((r) => r.allow ?? []));
  for (const rel of allowed) {
    const sql = sources.get(rel);
    assert.ok(sql, `${rel} is on an allow list but does not exist`);
    const needs = RULES.filter((r) => r.allow?.includes(rel) && sql.some((l) => r.pattern.test(l)));
    assert.ok(needs.length, `${rel} no longer needs an exception; take it off the list`);
  }
});
