// Fit scoring. One Claude call per posting with the approved prompt (prompts/score.md) and
// output schema (schemas/score.json); the Candidate Knowledge doc is the cached system prompt.
// Deterministic rules run first and after the call, so a clear location conflict can never be
// overridden by role-fit enthusiasm (v1's principle).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fillTemplate } from '../../tools/template.js';
import { homeAreaText } from '../../tools/config.js';
import { sanitizeDashes, truncate } from '../../tools/text.js';
import { repoPath } from '../../tools/paths.js';

// Chosen by the scoring eval (2026-09-30, 74 applied/passed cases): Sonnet 5.5 ranked applied above
// passed jobs 84% of the time (Haiku 4.5: 72%, v1: 71%). At 7+ it promotes 56% of applied jobs and
// 8% of passed ones. Rerun npm run eval:score before changing either value.
export const DEFAULT_SCORE_MODEL = 'claude-sonnet-5-5';
export const PROMOTE_AT = 7;
export const UNVERIFIED_CAP = 7;
export const CONFLICT_SCORE = 2;
export const MIN_KNOWLEDGE_CHARS = 500;
const CONTENT_CHARS = 6000;

/**
 * Per-model request settings. Sonnet 5.5 and Opus 5.5 always think; low effort keeps scoring
 * cheap, and maxTokens leaves room for thinking. Haiku 4.5 takes no effort setting.
 */
export const MODEL_SETTINGS = {
  'claude-haiku-4-5': { maxTokens: 1500 },
  'claude-sonnet-5-5': { maxTokens: 8000, effort: 'low' },
  'claude-opus-5-5': { maxTokens: 8000, effort: 'low' },
};

// Rough list prices (USD per million tokens) for dry-run and eval budget estimates only.
// Actual cost is computed by agent-core from real usage. expectedOutput is the average output
// (including thinking) measured in the 2026-09-30 eval; caching is ignored, so estimates run high.
const ESTIMATE_RATES = {
  'claude-haiku-4-5': { input: 1, output: 5, expectedOutput: 330 },
  'claude-sonnet-5-5': { input: 2, output: 10, expectedOutput: 550 },
  'claude-opus-5-5': { input: 4, output: 20, expectedOutput: 600 },
};

/** The approved prompt template and schema, plus a short version hash stored with every score. */
export function loadScorePrompt() {
  const template = readFileSync(repoPath('agents', 'discovery', 'prompts', 'score.md'), 'utf8');
  const schemaText = readFileSync(repoPath('agents', 'discovery', 'schemas', 'score.json'), 'utf8');
  const version = createHash('sha256').update(template).update(schemaText).digest('hex').slice(0, 10);
  return { template, schema: JSON.parse(schemaText), version };
}

/** Text Claude sees as the job's location. Postings already judged remote are shown as remote. */
function locationForPrompt(p) {
  const loc = (p.location ?? '').trim();
  if (p.location_check === 'remote' && !/\bremote\b/i.test(loc)) return loc ? `Remote (listed location: ${loc})` : 'Remote';
  return loc || 'Not specified';
}

/**
 * Builds the claude.send() options for one posting.
 * posting: { company, title, location, url, location_check, fetched_text?, jd_text? }
 */
export function buildScoreRequest(posting, { config, knowledge, model, prompt }) {
  const settings = MODEL_SETTINGS[model];
  if (!settings) throw new Error(`No scoring settings for model "${model}". Known: ${Object.keys(MODEL_SETTINGS).join(', ')}`);
  const text = posting.jd_text || posting.fetched_text || '';
  const filled = fillTemplate(prompt.template, {
    candidateName: config.candidate.name,
    homeLocations: homeAreaText(config),
    company: posting.company,
    roleTitle: posting.title,
    jobLocation: locationForPrompt(posting),
    jobUrl: posting.url || 'Not provided',
    locationNoteBlock:
      posting.location_check === 'remote_signal'
        ? `LOCATION NOTE (overrides location rule 1 below): The listed location is "${posting.location}", but the posting ` +
          'text indicates the role can be remote. Treat it as remote eligible and mention this in the reason.\n\n'
        : '',
    jobContentBlock: text.trim()
      ? `Job content:\n${truncate(text.trim(), CONTENT_CHARS)}\n\n`
      : 'No job content available; score on company, title, and location only.\n\n',
  });
  return { model, system: knowledge, prompt: filled, schema: prompt.schema, label: 'score', ...settings };
}

/** Cleans Claude's structured result and applies the deterministic caps. */
export function interpretResult(data, posting) {
  const clean = (v) => (Array.isArray(v) ? v.map((s) => sanitizeDashes(String(s))).filter(Boolean) : sanitizeDashes(v));
  const analysis = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'number' ? v : clean(v)]));
  let score = analysis.score;
  if (posting.location_check === 'unverified') score = Math.min(score, UNVERIFIED_CAP);
  if (analysis.locationConcern === 'conflict') score = Math.min(score, CONFLICT_SCORE);
  analysis.score = score;
  return { score, reason: analysis.reason, analysis };
}

/** The no-AI score for a clear location conflict. */
export function ruleScore(posting, config) {
  const reason =
    `Location conflict: listed in "${posting.location}", outside ${homeAreaText(config)}, ` +
    'and the posting shows no remote option. Scored by rule without an AI call.';
  return {
    score: CONFLICT_SCORE,
    reason,
    analysis: {
      score: CONFLICT_SCORE,
      reason,
      roleType: 'Unknown',
      locationConcern: 'conflict',
      strengths: [],
      watchOuts: [],
      topTalkingPoint: '',
      suggestedStatus: 'pass',
    },
  };
}

/**
 * Scores one posting: the location rule, or one Claude call. Shared by production runs and the eval.
 * Returns { score, reason, analysis, source: 'v2' | 'v2-rule', model, costUsd }.
 */
export async function scoreOne(posting, { config, claude, knowledge, model, prompt, trace }) {
  if (posting.location_check === 'conflict') return { ...ruleScore(posting, config), source: 'v2-rule', model: null, costUsd: 0 };
  const res = await claude.send({ ...buildScoreRequest(posting, { config, knowledge, model, prompt }), trace });
  return { ...interpretResult(res.data, posting), source: 'v2', model: res.model, costUsd: res.costUsd };
}

/** Rough cost estimate for scoring postings with a model (dry runs and eval budget guard). */
export function estimateCost(postings, { model, knowledgeChars, templateChars }) {
  const r = ESTIMATE_RATES[model];
  if (!r) return null;
  let usd = 0;
  for (const p of postings) {
    if (p.location_check === 'conflict') continue;
    const textChars = Math.min((p.jd_text || p.fetched_text || '').length, CONTENT_CHARS);
    const inputTokens = (knowledgeChars + templateChars + textChars) / 4;
    usd += (inputTokens * r.input + r.expectedOutput * r.output) / 1_000_000;
  }
  return usd;
}

/** Selects postings to score: v2-discovered, not yet scored by v2, not passed or rejected. */
export function selectPostings(db, { ids, allUnscored = false, limit } = {}) {
  const where = [
    "NOT EXISTS (SELECT 1 FROM scores s WHERE s.posting_id = p.id AND s.source IN ('v2', 'v2-rule'))",
    "p.status NOT IN ('passed', 'rejected')",
  ];
  const params = [];
  if (ids?.length) {
    where.push(`p.id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  } else if (!allUnscored) {
    where.push('p.fetch_status IS NOT NULL');
  }
  const sql = `SELECT p.* FROM postings p WHERE ${where.join(' AND ')} ORDER BY p.id${limit ? ' LIMIT ?' : ''}`;
  return db.prepare(sql).all(...params, ...(limit ? [limit] : []));
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/**
 * Scores selected postings, stores each score as it completes, and promotes high scores.
 * @param {object} ctx
 * @param {{db, tx}} ctx.store
 * @param {object} ctx.config
 * @param {{send: Function}} ctx.claude         from agent-core createClaude()
 * @param {string} ctx.knowledge                Candidate Knowledge text (system prompt)
 * @param {string} ctx.model
 * @param {object} [ctx.run]                    trace run from createTracer().startRun()
 * @param {object} [ctx.options]                { ids, allUnscored, limit, concurrency = 3, promoteAt = 8, maxConsecutiveFailures = 5 }
 */
export async function scorePostings({ store, config, claude, knowledge, model, run, now = new Date(), options = {} }) {
  const { ids, allUnscored, limit, concurrency = 3, promoteAt = PROMOTE_AT, maxConsecutiveFailures = 5 } = options;
  if (!knowledge || knowledge.length < MIN_KNOWLEDGE_CHARS) {
    throw new Error(`Candidate Knowledge is missing or under ${MIN_KNOWLEDGE_CHARS} characters; scoring aborted.`);
  }
  const { db } = store;
  const prompt = loadScorePrompt();
  const postings = selectPostings(db, { ids, allUnscored, limit });

  const insertScore = db.prepare(`INSERT INTO scores (posting_id, score, reason, analysis_json, source, model, prompt_version, run_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const promote = db.prepare("UPDATE postings SET stage = 'pipeline', updated_at = ? WHERE id = ? AND stage = 'discovered'");

  const summary = { selected: postings.length, scored: 0, ruleScored: 0, distribution: {}, promoted: [], failures: [], aborted: false };
  let consecutive = 0;
  run?.log?.('info', postings.length ? `Scoring ${postings.length} postings with ${model}` : 'Nothing to score');

  await mapLimit(postings, concurrency, async (p) => {
    if (summary.aborted) return;
    try {
      const result = await scoreOne(p, { config, claude, knowledge, model, prompt, trace: run });
      consecutive = 0;
      const nowIso = new Date().toISOString();
      store.tx(() => {
        insertScore.run(p.id, result.score, result.reason, JSON.stringify(result.analysis), result.source, result.model, prompt.version, run?.id ?? null, nowIso);
        if (result.score >= promoteAt && promote.run(nowIso, p.id).changes) summary.promoted.push(p.id);
      });
      summary.scored += 1;
      if (result.source === 'v2-rule') summary.ruleScored += 1;
      summary.distribution[result.score] = (summary.distribution[result.score] ?? 0) + 1;
      if (summary.promoted.includes(p.id)) run?.log?.('info', `#${p.id} scored ${result.score}, promoted to pipeline`);
      else if (summary.scored % 10 === 0 && summary.scored < postings.length) run?.log?.('info', `Scored ${summary.scored}/${postings.length}`);
    } catch (err) {
      consecutive += 1;
      summary.failures.push({ id: p.id, error: `${err.name}: ${err.message}` });
      run?.log?.('warn', `Scoring failed for posting ${p.id}: ${err.name}`);
      if (consecutive >= maxConsecutiveFailures) {
        summary.aborted = true;
        run?.log?.('error', `Stopping after ${consecutive} consecutive failures.`);
      }
    }
  });
  return { ...summary, promptVersion: prompt.version, model, now: now.toISOString() };
}
