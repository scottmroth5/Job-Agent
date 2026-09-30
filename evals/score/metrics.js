// Metrics for the scoring eval. Each item is { label: 'applied' | 'passed', score: number | null }.

/**
 * Share of (applied, passed) pairs where the applied job scored higher; ties count half.
 * 1.0 = scores perfectly separate what you pursued from what you passed on; 0.5 = no better than chance.
 * Items without a score are ignored. Returns null when there are no pairs.
 */
export function pairwiseAccuracy(items) {
  const applied = items.filter((i) => i.label === 'applied' && i.score != null).map((i) => i.score);
  const passed = items.filter((i) => i.label === 'passed' && i.score != null).map((i) => i.score);
  if (!applied.length || !passed.length) return null;
  let wins = 0;
  for (const a of applied) for (const p of passed) wins += a > p ? 1 : a === p ? 0.5 : 0;
  return wins / (applied.length * passed.length);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const share = (xs, pred) => (xs.length ? xs.filter(pred).length / xs.length : null);

/** Summary for one scorer (a model, or v1's stored scores). */
export function summarize(items, { promoteAt = 8 } = {}) {
  const scored = items.filter((i) => i.score != null);
  const applied = scored.filter((i) => i.label === 'applied').map((i) => i.score);
  const passed = scored.filter((i) => i.label === 'passed').map((i) => i.score);
  return {
    cases: items.length,
    scored: scored.length,
    failures: items.length - scored.length,
    pairwiseAccuracy: pairwiseAccuracy(items),
    meanApplied: mean(applied),
    meanPassed: mean(passed),
    appliedPromoted: share(applied, (s) => s >= promoteAt),
    passedPromoted: share(passed, (s) => s >= promoteAt),
  };
}
