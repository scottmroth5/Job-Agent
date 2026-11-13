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
  return `(CASE WHEN ${column} IS JSON OBJECT AND jsonb_typeof(${column}::jsonb -> '${key}') = 'number'
    THEN (${column}::jsonb ->> '${key}')::double precision END)`;
}
