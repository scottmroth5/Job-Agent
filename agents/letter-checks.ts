// Saved fact checks on cover letter versions (letter_checks, 022): one row per version, its claims as JSON with a
// dismissed flag on each. Rows copy user_id from the letter's artifact row, so another user's letter gets nothing.
// The check itself is agents/hunt/verify-letter.ts; runCheck ties them together and never throws.
import { verifyLetter, flagged } from './hunt/verify-letter.ts';
import type { Claude, Run } from '@scottmroth5/agent-core';
import type { Db } from '../tools/types.ts';
import type { LetterChecksRow } from '../db/types.ts';

/** One claim the check found in a letter (agents/hunt/verify-letter.ts), with the user's dismissal. */
export interface Claim {
  claim: string;
  kind: string;
  verdict: string;
  evidence: string;
  dismissed?: boolean;
}

/** A saved check as the panel shows it. */
export interface LetterCheck {
  status: string;
  claims: Claim[];
  model: string | null;
  checkedAt: string;
}

const parse = (row: LetterChecksRow | undefined): LetterCheck | null =>
  row
    ? {
        status: row.status,
        claims: row.claims_json ? JSON.parse(row.claims_json) : [],
        model: row.model,
        checkedAt: row.updated_at,
      }
    : null;

/** The check on one letter version, or null when it has none. */
export const checkFor = async (db: Db, artifactId: number) =>
  parse(await db.prepare('SELECT * FROM letter_checks WHERE artifact_id = ? AND user_id = @uid').get(artifactId) as LetterChecksRow | undefined);

/** Checks for many versions at once: Map of artifact id to check. */
export async function checksFor(db: Db, artifactIds: number[]): Promise<Map<number, LetterCheck | null>> {
  if (!artifactIds.length) return new Map();
  const rows = await db.prepare(`SELECT * FROM letter_checks WHERE user_id = @uid AND artifact_id IN (${artifactIds.map(() => '?').join(', ')})`).all(...artifactIds) as LetterChecksRow[];
  return new Map(rows.map((r) => [r.artifact_id, parse(r)]));
}

/** Saves (or replaces) a version's check. status 'failed' keeps no claims. */
export async function saveCheck(
  db: Db,
  artifactId: number,
  { status, claims = [], model = null, promptVersion = null, runId = null }: { status: 'checked' | 'failed'; claims?: Claim[]; model?: string | null; promptVersion?: string | null; runId?: number | null },
  now = new Date(),
) {
  const at = now.toISOString();
  await db.prepare(`INSERT INTO letter_checks (artifact_id, user_id, status, claims_json, model, prompt_version, run_id, created_at, updated_at)
      SELECT id, user_id, ?, ?, ?, ?, ?, ?, ? FROM artifacts WHERE id = ? AND user_id = @uid AND kind = 'cover_letter'
      ON CONFLICT(artifact_id) DO UPDATE SET status = excluded.status, claims_json = excluded.claims_json, model = excluded.model,
        prompt_version = excluded.prompt_version, run_id = excluded.run_id, updated_at = excluded.updated_at`).run(
    status,
    status === 'checked' ? JSON.stringify(claims.map((c) => ({ ...c, dismissed: false }))) : null,
    model,
    promptVersion,
    runId,
    at,
    at,
    artifactId,
  );
  return await checkFor(db, artifactId);
}

/** Marks one claim dismissed (by its index in the saved list). null when the version or claim is not there. */
export async function dismissClaim(db: Db, artifactId: number, index: number, now = new Date()) {
  // The claims are read and written in one transaction, so two dismissals at once both stay.
  return db.tx(async () => {
    const check = await checkFor(db, artifactId);
    if (!check || !check.claims[index]) return null;
    const claims = check.claims.map((c, i) => (i === index ? { ...c, dismissed: true } : c));
    await db.prepare('UPDATE letter_checks SET claims_json = ?, updated_at = ? WHERE artifact_id = ? AND user_id = @uid').run(JSON.stringify(claims), now.toISOString(), artifactId);
    return await checkFor(db, artifactId);
  });
}

/** A restored version has the same text, so it gets the old version's check (dismissals included). */
export async function copyCheck(db: Db, fromId: number, toId: number) {
  await db.prepare(`INSERT OR IGNORE INTO letter_checks (artifact_id, user_id, status, claims_json, model, prompt_version, run_id, created_at, updated_at)
      SELECT a.id, a.user_id, c.status, c.claims_json, c.model, c.prompt_version, c.run_id, c.created_at, c.updated_at
      FROM letter_checks c JOIN artifacts a ON a.id = ? AND a.user_id = c.user_id
      WHERE c.artifact_id = ? AND c.user_id = @uid`).run(toId, fromId);
}

/**
 * Checks a saved letter version and stores the result. Never throws: a failure is saved as a failed check, so the
 * letter is untouched. Returns the saved check plus flagged (contradicted and unsupported) for counts.
 */
export async function runCheck({ db, claude, background, posting, artifactId, letter, config, trace = null }: {
  db: Db;
  claude: Claude;
  background: string;
  posting: { company: string; title: string; jd_text?: string | null; fetched_text?: string | null };
  artifactId: number;
  letter: string;
  config: { candidate?: { name?: string } } | null;
  trace?: Run | null;
}) {
  try {
    const r = await verifyLetter({ claude, db, background, posting, letter, config, trace });
    const check = await saveCheck(db, artifactId, { status: 'checked', claims: r.claims, model: r.model, promptVersion: r.promptVersion, runId: trace?.id ?? null });
    return { check, flagged: flagged(r.claims).length };
  } catch (err) {
    trace?.log?.('warn', `Letter check failed: ${(err as Error).name}`);
    return { check: await saveCheck(db, artifactId, { status: 'failed', runId: trace?.id ?? null }), flagged: 0, error: err };
  }
}
