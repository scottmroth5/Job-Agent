// The scam warning eval (npm run eval:scam): the production rules (scamSignals, isFlagged) and Claude check (checkScam,
// the prompt in effect) over synthetic postings (evals/scam/cases.json). The rules are free; only the cases they flag
// reach a model, as in production. Writes nothing to the database beyond the traced run's call records.
import { checkScam, isFlagged, scamSignals } from '../../agents/discovery/scam.ts';
import { getPrompt } from '../../agents/prompts.ts';
/**
 * @import { Claude, Run } from '@scottmroth5/agent-core'
 * @import { Db } from '../../tools/types.ts'
 */

/**
 * @typedef {{ id: string, scam: boolean, company: string, title: string, text: string }} ScamCase
 * @typedef {{ about?: string, cases: ScamCase[] }} ScamCases
 */

// Rough list prices (USD per million tokens) and the expected output, for estimates only.
/** @type {Record<string, { input: number, output: number, expectedOutput: number } | undefined>} */
const ESTIMATE_RATES = {
  'claude-haiku-4-5': { input: 1, output: 5, expectedOutput: 500 },
  'claude-sonnet-5-5': { input: 2, output: 10, expectedOutput: 1500 },
  'claude-opus-5-5': { input: 4, output: 20, expectedOutput: 1500 },
};

const posting = (/** @type {ScamCase} */ c) => ({ company: c.company, title: c.title, jd_text: c.text });

/**
 * What the free rules do: recall on scams, and which real-looking postings they flag.
 * @param {ScamCases} cases
 */
export function ruleMetrics(cases) {
  const flagged = cases.cases.filter((c) => isFlagged(scamSignals(posting(c))));
  const scams = cases.cases.filter((c) => c.scam);
  const real = cases.cases.filter((c) => !c.scam);
  return {
    scams: scams.length,
    real: real.length,
    scamsFlagged: flagged.filter((c) => c.scam).length,
    missed: scams.filter((c) => !flagged.includes(c)).map((c) => c.id),
    realFlagged: flagged.filter((c) => !c.scam).map((c) => c.id),
    flaggedIds: flagged.map((c) => c.id),
  };
}

/**
 * Estimated cost per model: every flagged case with the prompt.
 * @param {ScamCases} cases
 * @param {string[]} models
 * @param {Db | null} [db]
 */
export async function estimateScamEval(cases, models, db = null) {
  const templateChars = (await getPrompt(db, 'scam-check')).template.length + 600; // the fixed system prompt and the signs
  const flagged = cases.cases.filter((c) => isFlagged(scamSignals(posting(c))));
  return Object.fromEntries(
    models.map((m) => {
      const r = ESTIMATE_RATES[m];
      if (!r) return [m, null];
      const input = flagged.reduce((s, c) => s + (c.text.length + templateChars) / 4, 0);
      return [m, (input * r.input + flagged.length * r.expectedOutput * r.output) / 1e6];
    }),
  );
}

/**
 * Runs the Claude check on each flagged case for each model. A warning is a medium or high likelihood, as in the job
 * list. Returns per model: scams warned (of all scams, so the rules' misses count), real postings warned, and cost.
 * @param {{ cases: ScamCases, models: string[], claude: Claude, db?: Db | null, trace?: Run | null, log?: (m: string) => void }} opts
 */
export async function runScamEval({ cases, models, claude, db = null, trace = null, log = () => {} }) {
  const prompt = await getPrompt(db, 'scam-check');
  const flagged = cases.cases.filter((c) => isFlagged(scamSignals(posting(c))));
  const scams = cases.cases.filter((c) => c.scam).length;
  const real = cases.cases.length - scams;
  /** @type {Record<string, { scamsWarned: number, scams: number, missed: string[], realWarned: string[], failed: number, byCase: Record<string, string> }>} */
  const perModel = {};
  for (const model of models) {
    const r = { scamsWarned: 0, scams, missed: /** @type {string[]} */ ([]), realWarned: /** @type {string[]} */ ([]), failed: 0, byCase: /** @type {Record<string, string>} */ ({}) };
    for (const c of cases.cases) {
      if (!flagged.includes(c)) {
        if (c.scam) r.missed.push(`${c.id} (rules)`);
        continue;
      }
      try {
        const out = await checkScam({ claude, db, posting: posting(c), signals: scamSignals(posting(c)), trace, model, prompt });
        r.byCase[c.id] = out.likelihood;
        const warned = out.likelihood === 'medium' || out.likelihood === 'high';
        if (c.scam && warned) r.scamsWarned += 1;
        else if (c.scam) r.missed.push(c.id);
        else if (warned) r.realWarned.push(c.id);
        log(`${model} ${c.id}: ${out.likelihood}`);
      } catch (err) {
        r.failed += 1;
        if (c.scam) r.missed.push(`${c.id} (failed)`);
        log(`${model} ${c.id}: failed (${/** @type {Error} */ (err).name})`);
      }
    }
    perModel[model] = r;
  }
  return { perModel, real, promptVersion: prompt.version };
}
