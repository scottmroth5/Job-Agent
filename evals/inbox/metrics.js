// Metrics for the inbox eval. Each result: { expected: { applicationId, type }, passed (pre-filter),
// predicted: { applicationId, type, reviewStatus } | null, rule }.

const share = (xs, pred) => (xs.length ? xs.filter(pred).length / xs.length : null);
const isJob = (r) => r.expected.type !== 'other';

export function inboxMetrics(results) {
  const passed = results.filter((r) => r.passed);
  return {
    cases: results.length,
    // Pre-filter: job emails kept, and non-job emails dropped before any Claude call.
    prefilterRecall: share(results.filter(isJob), (r) => r.passed),
    prefilterDropRate: share(results.filter((r) => !isJob(r)), (r) => !r.passed),
    classified: passed.length,
    // Over emails that reached classification: the final link (after the confidence gate) and the type.
    matchAccuracy: share(passed, (r) => (r.predicted.applicationId ?? null) === (r.expected.applicationId ?? null)),
    classificationAccuracy: share(passed, (r) => r.predicted.type === r.expected.type),
    wrongLinks: passed.filter((r) => r.predicted.applicationId != null && r.predicted.applicationId !== r.expected.applicationId).length,
    reviewRate: share(passed, (r) => r.predicted.reviewStatus === 'needs_review'),
    ruleMatchRate: share(passed, (r) => r.rule && r.rule !== 'model'),
  };
}
