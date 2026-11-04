// Runs the letter fact check (the production verifyLetter and the prompt in effect) over the synthetic cases for each
// model, and scores it with metrics.js. Writes nothing to the database beyond the traced run's call records.
import { verifyLetter, VERIFY_SETTINGS } from '../../agents/hunt/verify-letter.ts';
import { getPrompt } from '../../agents/prompts.ts';
import { letterMetrics } from './metrics.js';

// Rough list prices (USD per million tokens) and the expected output (thinking included) for estimates only;
// the real cost comes from agent-core and the API's usage.
const ESTIMATE_RATES = {
  'claude-haiku-4-5': { input: 1, output: 5, expectedOutput: 1000 },
  'claude-sonnet-5-5': { input: 2, output: 10, expectedOutput: 2000 },
  'claude-opus-5-5': { input: 4, output: 20, expectedOutput: 2000 },
};

/** Estimated cost per model: every letter with its background, posting, and the prompt. */
export function estimateLetterEval(cases, models, db = null) {
  const templateChars = getPrompt(db, 'verify-letter').template.length;
  const background = cases.knowledge.length + cases.resume.length;
  return Object.fromEntries(
    models.map((m) => {
      const r = ESTIMATE_RATES[m];
      if (!r) return [m, null];
      const usd = cases.letters.reduce((s, l) => s + ((background + templateChars + l.letter.length + cases.postings[l.posting].jd_text.length) / 4 * r.input + r.expectedOutput * r.output) / 1_000_000, 0);
      return [m, usd];
    }),
  );
}

/** { perModel: { [model]: { results, metrics } } }; one letter at a time per model. */
export async function runLetterEval({ cases, models, claude, db = null, trace = null, log = () => {} }) {
  const prompt = getPrompt(db, 'verify-letter');
  const background = `${cases.knowledge}\n\nRESUME:\n${cases.resume}`;
  const config = { candidate: cases.candidate };
  const perModel = {};
  for (const model of models) {
    if (!VERIFY_SETTINGS[model]) throw new Error(`No fact check settings for model "${model}".`);
    const results = [];
    for (const l of cases.letters) {
      const t0 = Date.now();
      try {
        const r = await verifyLetter({ claude, background, posting: cases.postings[l.posting], letter: l.letter, config, trace, model, prompt });
        results.push({ id: l.id, expect: l.expect, claims: r.claims, costUsd: r.costUsd ?? 0, ms: Date.now() - t0 });
      } catch (err) {
        results.push({ id: l.id, expect: l.expect, claims: [], error: err.name, costUsd: 0, ms: Date.now() - t0 });
      }
      log(`${model} ${l.id}: done`);
    }
    perModel[model] = { results, metrics: letterMetrics(results) };
  }
  return { perModel, promptVersion: prompt.version };
}
