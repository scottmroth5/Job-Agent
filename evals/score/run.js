// Runs scoring models over the eval cases with the production scoring code (scoreOne), and
// summarizes each model next to v1's stored scores. Writes nothing to postings.
import { scoreOne, estimateCost, loadScorePrompt, PROMOTE_AT } from '../../agents/discovery/score.js';
import { summarize } from './metrics.js';

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** Estimated total cost of running these models over these cases. */
export function estimateEval(cases, models, knowledgeChars, db = null) {
  const templateChars = loadScorePrompt('fulltime', db).template.length;
  return Object.fromEntries(models.map((m) => [m, estimateCost(cases, { model: m, knowledgeChars, templateChars })]));
}

/**
 * Uses the full-time scoring prompt in effect (an admin-screen edit if active), so evals test current edits.
 * @returns {Promise<{ perModel: Record<string, {results: object[], summary: object, costUsd: number, avgMs: number}>, v1: object }>}
 */
export async function runEval({ cases, models, claude, config, knowledge, run, db = null, concurrency = 3, promoteAt = PROMOTE_AT, log = () => {} }) {
  const prompt = loadScorePrompt('fulltime', db);
  const perModel = {};
  for (const model of models) {
    const results = [];
    await mapLimit(cases, concurrency, async (c) => {
      const t0 = Date.now();
      try {
        const r = await scoreOne(c, { config, claude, knowledge, model, prompt, trace: run });
        results.push({ id: c.id, label: c.label, score: r.score, reason: r.reason, source: r.source, costUsd: r.costUsd ?? 0, ms: Date.now() - t0 });
      } catch (err) {
        results.push({ id: c.id, label: c.label, score: null, error: `${err.name}: ${err.message}`, costUsd: 0, ms: Date.now() - t0 });
      }
    });
    results.sort((a, b) => a.id - b.id);
    const costUsd = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const avgMs = results.length ? Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length) : 0;
    perModel[model] = { results, summary: summarize(results, { promoteAt }), costUsd, avgMs };
    log(`${model}: ${results.filter((r) => r.score != null).length}/${cases.length} scored, $${costUsd.toFixed(3)}`);
  }
  const v1 = summarize(cases.map((c) => ({ label: c.label, score: c.v1Score })), { promoteAt });
  return { perModel, v1, promptVersion: prompt.version };
}
