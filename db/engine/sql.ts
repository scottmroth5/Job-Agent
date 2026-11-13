// Portable SQL (v3 Phase 4): app SQL is written once and runs on SQLite and PostgreSQL. These helpers cover the few
// fragments the two dialects spell differently, and the statement facts every engine reads the same way.
// test/portable-sql.test.js keeps SQLite-only syntax out of app code.
import type { Dialect } from './types.ts';

/** True when a statement ends in RETURNING id: the only statements whose run() reports the new row's id. */
export const returnsId = (sql: string): boolean => /\bRETURNING\s+id\s*;?\s*$/i.test(sql);

/**
 * A number stored at key in a JSON text column, or NULL when the text is not JSON or has no number there. The column
 * and key are code, never user input (the key is checked).
 */
export function jsonNumber(dialect: Dialect, column: string, key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`jsonNumber: unsafe key ${key}`);
  if (dialect === 'sqlite') return `(CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.${key}') END)`;
  // Nested CASE, not AND: PostgreSQL may evaluate AND's sides in any order, and the cast fails on text that is not JSON.
  return `(CASE WHEN ${column} IS JSON OBJECT THEN CASE WHEN jsonb_typeof(${column}::jsonb -> '${key}') = 'number'
    THEN (${column}::jsonb ->> '${key}')::double precision END END)`;
}

/** Where a statement's values go once its placeholders are numbered: the next positional value, or a named one. */
export type Slot = { kind: 'positional' } | { kind: 'named'; name: string };

/**
 * Rewrites ? and @name placeholders to PostgreSQL's $1, $2, ... A repeated @name keeps its number. Text inside string
 * literals, quoted names, comments, and dollar-quoted bodies is left alone. Returns the text and, per number, its slot.
 */
export function numberPlaceholders(sql: string): { text: string; slots: Slot[] } {
  const slots: Slot[] = [];
  const named = new Map<string, number>();
  let out = '';
  let i = 0;
  const copyUntil = (end: string, from: number) => {
    const at = sql.indexOf(end, from);
    const stop = at < 0 ? sql.length : at + end.length;
    out += sql.slice(i, stop);
    i = stop;
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'") {
      // '' inside a literal is an escaped quote: keep reading past it
      let j = i + 1;
      for (;;) {
        const q = sql.indexOf("'", j);
        if (q < 0) { j = sql.length; break; }
        if (sql[q + 1] === "'") { j = q + 2; continue; }
        j = q + 1;
        break;
      }
      out += sql.slice(i, j);
      i = j;
    } else if (c === '"') copyUntil('"', i + 1);
    else if (c === '-' && next === '-') copyUntil('\n', i + 2);
    else if (c === '/' && next === '*') copyUntil('*/', i + 2);
    else if (c === '$' && /[A-Za-z_$]/.test(next ?? '')) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) copyUntil(tag[0], i + tag[0].length);
      else { out += c; i += 1; }
    } else if (c === '?') {
      slots.push({ kind: 'positional' });
      out += `$${slots.length}`;
      i += 1;
    } else if (c === '@' && /[A-Za-z_]/.test(next ?? '')) {
      const name = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i))![1];
      let n = named.get(name);
      if (n === undefined) {
        slots.push({ kind: 'named', name });
        n = slots.length;
        named.set(name, n);
      }
      out += `$${n}`;
      i += name.length + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return { text: out, slots };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;

/**
 * The values for numbered placeholders, from arguments bound the way better-sqlite3 takes them: positional values in
 * order, and one plain object of named values (db/scope.ts bindUid adds uid to it, or appends it). Errors match
 * better-sqlite3's: too many or too few positional values, or a missing named one. undefined binds as NULL.
 */
export function bindValues(slots: Slot[], args: unknown[]): unknown[] {
  const wantsNamed = slots.some((s) => s.kind === 'named');
  const last = args.at(-1);
  const namedValues = wantsNamed && isPlainObject(last) ? last : null;
  const positional = namedValues ? args.slice(0, -1) : args;
  const want = slots.filter((s) => s.kind === 'positional').length;
  if (positional.length > want) throw new RangeError('Too many parameter values were provided');
  if (positional.length < want) throw new RangeError('Too few parameter values were provided');
  let p = 0;
  return slots.map((s) => {
    if (s.kind === 'positional') return positional[p++] ?? null;
    if (!namedValues || !(s.name in namedValues)) throw new RangeError(`Missing named parameter "${s.name}"`);
    return namedValues[s.name] ?? null;
  });
}
