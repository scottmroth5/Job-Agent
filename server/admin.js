// Admin routes: view and edit the four prompts (stored in the database with history), and preview
// a prompt filled with a real job. Output schemas are shown read-only.
import { PROMPTS, getPrompt, defaultPrompt, savePrompt, restorePrompt, listVersions, validateTemplate } from '../agents/prompts.js';
import { buildScoreRequest, DEFAULT_SCORE_MODEL } from '../agents/discovery/score.js';
import { buildTweaksRequest, buildLetterRequest } from '../agents/hunt/generate.js';

const NAMES = Object.keys(PROMPTS);
const nameParams = { type: 'object', required: ['name'], properties: { name: { type: 'string', enum: NAMES } } };
const anyObject = { type: 'object', additionalProperties: true };

function detail(db, name) {
  const def = PROMPTS[name];
  const current = getPrompt(db, name);
  const base = defaultPrompt(name);
  return {
    name,
    label: def.label,
    usedBy: def.usedBy,
    template: current.template,
    defaultTemplate: base.template,
    source: current.source,
    version: current.version,
    versionId: current.versionId,
    note: current.note,
    updatedAt: current.updatedAt,
    allowed: def.allowed,
    required: def.required,
    schema: base.schemaText,
    versions: listVersions(db, name),
  };
}

/** A job to preview with: the one asked for, else a recent one with text (and an analysis for hunt prompts). */
function samplePosting(db, name, postingId) {
  const needsAnalysis = name === 'resume-tweaks' || name === 'cover-letter';
  const track = name === 'score-fractional' ? 'fractional' : name === 'score' ? 'fulltime' : null;
  const analysisSql = `(SELECT analysis_json FROM scores s WHERE s.posting_id = p.id AND s.source IN ('v2', 'v2-rule') ORDER BY s.id DESC LIMIT 1)`;
  if (postingId) return db.prepare(`SELECT p.*, ${analysisSql} AS analysis_json FROM postings p WHERE p.id = ?`).get(postingId) ?? null;
  return (
    db
      .prepare(`SELECT p.*, ${analysisSql} AS analysis_json FROM postings p
        WHERE (p.fetched_text IS NOT NULL OR p.jd_text IS NOT NULL) ${track ? 'AND p.track = @track' : ''}
        ${needsAnalysis ? `AND ${analysisSql} IS NOT NULL` : ''}
        ORDER BY p.id DESC LIMIT 1`)
      .get(track ? { track } : {}) ?? null
  );
}

export function registerAdminRoutes(app, { db, config }) {
  app.get('/api/admin/prompts', { schema: { summary: 'The editable prompts', response: { 200: { type: 'array', items: anyObject } } } }, async () =>
    NAMES.map((name) => {
      const p = getPrompt(db, name);
      return { name, label: PROMPTS[name].label, usedBy: PROMPTS[name].usedBy, source: p.source, version: p.version, updatedAt: p.updatedAt, versions: listVersions(db, name).length };
    }),
  );

  app.get('/api/admin/prompts/:name', { schema: { summary: 'A prompt with its default, placeholders, schema and history', params: nameParams, response: { 200: anyObject } } }, async (req) =>
    detail(db, req.params.name),
  );

  app.put(
    '/api/admin/prompts/:name',
    {
      schema: {
        summary: 'Save a new version of a prompt (validated; becomes active)',
        params: nameParams,
        body: { type: 'object', required: ['template'], additionalProperties: false, properties: { template: { type: 'string', maxLength: 20000 }, note: { type: 'string', maxLength: 500 } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      savePrompt(db, req.params.name, req.body);
      return detail(db, req.params.name);
    },
  );

  app.post(
    '/api/admin/prompts/:name/restore',
    {
      schema: {
        summary: 'Make an earlier version active, or return to the repo default (versionId null)',
        params: nameParams,
        body: { type: 'object', required: ['versionId'], additionalProperties: false, properties: { versionId: { type: ['integer', 'null'] } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      restorePrompt(db, req.params.name, req.body.versionId);
      return detail(db, req.params.name);
    },
  );

  app.post(
    '/api/admin/prompts/:name/preview',
    {
      schema: {
        summary: 'Fill a draft prompt with a real job (no Claude call)',
        params: nameParams,
        body: { type: 'object', required: ['template'], additionalProperties: false, properties: { template: { type: 'string', maxLength: 20000 }, postingId: { type: 'integer', minimum: 1 } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const { name } = req.params;
      const problems = validateTemplate(name, req.body.template);
      if (problems.length) return { problems, text: null, posting: null };
      const posting = samplePosting(db, name, req.body.postingId);
      if (!posting) return { problems: [], text: null, posting: null, message: 'No job with posting text (and, for resume tweaks and letters, a v2 analysis) to preview with yet.' };
      const draft = { template: req.body.template, schema: defaultPrompt(name).schema, version: 'draft', track: posting.track };
      let text;
      if (name === 'score' || name === 'score-fractional') {
        text = buildScoreRequest(posting, { config, knowledge: '', model: DEFAULT_SCORE_MODEL, prompt: draft }).prompt;
      } else {
        const analysis = JSON.parse(posting.analysis_json);
        const current = { tweaks: getPrompt(db, 'resume-tweaks'), letter: getPrompt(db, 'cover-letter') };
        const prompts = name === 'resume-tweaks' ? { ...current, tweaks: draft } : { ...current, letter: draft };
        const build = name === 'resume-tweaks' ? buildTweaksRequest : buildLetterRequest;
        text = build(posting, analysis, { config, knowledge: '', prompts }).prompt;
      }
      return { problems: [], text, posting: { id: posting.id, title: posting.title, company: posting.company } };
    },
  );
}
