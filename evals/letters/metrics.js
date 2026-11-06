// Scores the letter fact check on the synthetic cases (evals/letters/cases.json). A planted error is found when a
// contradicted or unsupported claim mentions one of its words; any other flagged claim is an extra flag, and on a clean
// letter every flagged claim is a false flag.

/**
 * @typedef {{ kind: string, mentions: string[] }} PlantedError
 * @typedef {{ claim: string, verdict: string, evidence?: string | null }} JudgedClaim
 * @typedef {{ id: string, expect: PlantedError | null, claims: JudgedClaim[] | null, error?: string, costUsd?: number, ms?: number }} LetterResult
 * @typedef {LetterResult & ReturnType<typeof judgeLetter> & { failed: boolean }} Judged
 */

const FLAGGED = new Set(['contradicted', 'unsupported']);
/** @param {unknown} s */
const lower = (s) => String(s ?? '').toLowerCase();

/**
 * One letter's outcome: { found, flags, extra } (found is null for a clean letter).
 * @param {PlantedError | null | undefined} expect
 * @param {JudgedClaim[] | null | undefined} claims
 */
export function judgeLetter(expect, claims) {
  const flags = (claims ?? []).filter((c) => FLAGGED.has(c.verdict));
  if (!expect) return { found: null, flags: flags.length, extra: flags.length };
  const hits = flags.filter((c) => expect.mentions.some((m) => lower(`${c.claim} ${c.evidence}`).includes(lower(m))));
  return { found: hits.length > 0, flags: flags.length, extra: flags.length - hits.length };
}

/**
 * Totals across letters: results are { id, expect, claims, error?, costUsd, ms }.
 * recall: planted errors found / planted; falseFlagRate: clean letters with any flag / clean letters.
 * @param {LetterResult[]} results
 */
export function letterMetrics(results) {
  const judged = results.map((r) => ({ ...r, ...judgeLetter(r.expect, r.claims), failed: Boolean(r.error) }));
  const planted = judged.filter(/** @param {Judged} r @returns {r is Judged & { expect: PlantedError }} */ (r) => Boolean(r.expect));
  const clean = judged.filter((r) => !r.expect);
  /** @type {Record<string, { planted: number, found: number }>} */
  const byKind = {};
  for (const r of planted) {
    const k = (byKind[r.expect.kind] ??= { planted: 0, found: 0 });
    k.planted += 1;
    k.found += r.found ? 1 : 0;
  }
  const n = results.length || 1;
  return {
    letters: results.length,
    failed: judged.filter((r) => r.failed).length,
    planted: planted.length,
    found: planted.filter((r) => r.found).length,
    recall: planted.length ? planted.filter((r) => r.found).length / planted.length : null,
    byKind,
    missed: planted.filter((r) => !r.found).map((r) => r.id),
    clean: clean.length,
    cleanFlagged: clean.filter((r) => r.flags > 0).map((r) => r.id),
    falseFlagRate: clean.length ? clean.filter((r) => r.flags > 0).length / clean.length : null,
    extraFlags: judged.reduce((s, r) => s + r.extra, 0),
    costPerLetter: results.reduce((s, r) => s + (r.costUsd ?? 0), 0) / n,
    avgMs: results.reduce((s, r) => s + (r.ms ?? 0), 0) / n,
  };
}
