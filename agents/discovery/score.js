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

/**
 * The approved prompt template and schema for a track, plus a short version hash stored with every score.
 * 'fulltime' uses score.md/score.json; 'fractional' uses score-fractional.md/score-fractional.json.
 */
export function loadScorePrompt(track = 'fulltime') {
  const name = track === 'fractional' ? 'score-fractional' : 'score';
  const template = readFileSync(repoPath('agents', 'discovery', 'prompts', `${name}.md`), 'utf8');
  const schemaText = readFileSync(repoPath('agents', 'discovery', 'schemas', `${name}.json`), 'utf8');
  const version = createHash('sha256').update(template).update(schemaText).digest('hex').slice(0, 10);
  return { template, schema: JSON.parse(schemaText), version, track };
}

/** Both tracks' prompts, keyed by track. */
export function loadScorePrompts() {
  return { fulltime: loadScorePrompt('fulltime'), fractional: loadScorePrompt('fractional') };
}

/** The prompt for a posting's track, from either a single prompt or a { fulltime, fractional } set. */
export function promptFor(posting, { prompt, prompts }) {
  if (prompts) return prompts[posting.track === 'fractional' ? 'fractional' : 'fulltime'];
  return prompt;
}

const k = (n) => `$${Math.round(n / 1000)}K`;

/** "$200K to $250K" from config.fractional.targetAnnual. */
function stackingTarget(config) {
  const t = config.fractional?.targetAnnual;
  return t ? `${k(t[0])} to ${k(t[1])}` : 'a full-time income';
}

/** Posted pay and hours for the fractional prompt, when the source gave them. */
function termsBlock(p) {
  const parts = [];
  if (p.rate_text) parts.push(`pay ${p.rate_text}`);
  else if (p.rate_min != null) parts.push(`pay ${k(p.rate_min)}${p.rate_max !== p.rate_min ? ` to ${k(p.rate_max)}` : ''} per ${p.rate_unit ?? 'period'}`);
  if (p.hours_min != null) parts.push(`${p.hours_min}${p.hours_max !== p.hours_min ? ` to ${p.hours_max}` : ''} hours per week`);
  return parts.length ? `Posted terms: ${parts.join(', ')}\n` : '';
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
export function buildScoreRequest(posting, { config, knowledge, model, prompt, prompts }) {
  const settings = MODEL_SETTINGS[model];
  if (!settings) throw new Error(`No scoring settings for model "${model}". Known: ${Object.keys(MODEL_SETTINGS).join(', ')}`);
  const chosen = promptFor(posting, { prompt, prompts });
  const text = posting.jd_text || posting.fetched_text || '';
  const filled = fillTemplate(chosen.template, {
    candidateName: config.candidate.name,
    homeLocations: homeAreaText(config),
    stackingTarget: stackingTarget(config),
    termsBlock: termsBlock(posting),
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
  return { model, system: knowledge, prompt: filled, schema: chosen.schema, label: chosen.track === 'fractional' ? 'score-fractional' : 'score', ...settings };
}

/** Cleans Claude's structured result and applies the deterministic caps. */
export function interpretResult(data, posting) {
  const clean = (v) => {
    if (Array.isArray(v)) return v.map((s) => sanitizeDashes(String(s))).filter(Boolean);
    if (typeof v === 'string') return sanitizeDashes(v);
    return v; // numbers, null, and nested objects such as rate and hoursPerWeek
  };
  const analysis = Object.fromEntries(Object.entries(data).map(([key, v]) => [key, clean(v)]));
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
export async function scoreOne(posting, { config, claude, knowledge, model, prompt, prompts, trace }) {
  if (posting.location_check === 'conflict') return { ...ruleScore(posting, config), source: 'v2-rule', model: null, costUsd: 0 };
  const res = await claude.send({ ...buildScoreRequest(posting, { config, knowledge, model, prompt, prompts }), trace });
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
export function selectPostings(db, { ids, allUnscored = false, limit, rescore = false } = {}) {
  const where = [];
  // rescore (with ids) scores again even when a v2 score exists and whatever the status; used by the UI's Re-score.
  if (!(rescore && ids?.length)) {
    where.push("NOT EXISTS (SELECT 1 FROM scores s WHERE s.posting_id = p.id AND s.source IN ('v2', 'v2-rule'))");
    where.push("p.status NOT IN ('passed', 'rejected')");
  }
  const params = [];
  if (ids?.length) {
    where.push(`p.id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  } else if (!allUnscored) {
    where.push('p.fetch_status IS NOT NULL');
  }
  const sql = `SELECT p.* FROM postings p ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.id${limit ? ' LIMIT ?' : ''}`;
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
  const { ids, allUnscored, limit, rescore, concurrency = 3, promoteAt = PROMOTE_AT, maxConsecutiveFailures = 5 } = options;
  if (!knowledge || knowledge.length < MIN_KNOWLEDGE_CHARS) {
    throw new Error(`Candidate Knowledge is missing or under ${MIN_KNOWLEDGE_CHARS} characters; scoring aborted.`);
  }
  const { db } = store;
  const prompts = loadScorePrompts();
  const postings = selectPostings(db, { ids, allUnscored, limit, rescore });

  const insertScore = db.prepare(`INSERT INTO scores (posting_id, score, reason, analysis_json, source, model, prompt_version, run_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const promote = db.prepare("UPDATE postings SET stage = 'pipeline', updated_at = ? WHERE id = ? AND stage = 'discovered'");
  // Fractional scoring reports pay and hours from the posting text; keep what the source already gave.
  const fillTerms = db.prepare(`UPDATE postings SET rate_min = COALESCE(rate_min, @rateMin), rate_max = COALESCE(rate_max, @rateMax),
      rate_unit = COALESCE(rate_unit, @rateUnit), hours_min = COALESCE(hours_min, @hoursMin), hours_max = COALESCE(hours_max, @hoursMax)
    WHERE id = @id`);

  const summary = { selected: postings.length, scored: 0, ruleScored: 0, distribution: {}, promoted: [], failures: [], aborted: false };
  let consecutive = 0;
  run?.log?.('info', postings.length ? `Scoring ${postings.length} postings with ${model}` : 'Nothing to score');

  await mapLimit(postings, concurrency, async (p) => {
    if (summary.aborted) return;
    try {
      const result = await scoreOne(p, { config, claude, knowledge, model, prompts, trace: run });
      consecutive = 0;
      const nowIso = new Date().toISOString();
      const version = promptFor(p, { prompts }).version;
      const { rate, hoursPerWeek } = result.analysis;
      store.tx(() => {
        insertScore.run(p.id, result.score, result.reason, JSON.stringify(result.analysis), result.source, result.model, version, run?.id ?? null, nowIso);
        if (rate || hoursPerWeek) {
          fillTerms.run({
            id: p.id,
            rateMin: rate?.min ?? null,
            rateMax: rate?.max ?? rate?.min ?? null,
            rateUnit: rate?.min != null && rate.unit !== 'unknown' ? rate.unit : null,
            hoursMin: hoursPerWeek?.min ?? null,
            hoursMax: hoursPerWeek?.max ?? hoursPerWeek?.min ?? null,
          });
        }
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
  return { ...summary, promptVersion: prompts.fulltime.version, fractionalPromptVersion: prompts.fractional.version, model, now: now.toISOString() };
}
