// The four editable prompts. Repo files are the defaults; admin-screen edits are stored in the
// database (prompt_versions) with history, and the active edit wins. Output schemas stay in the
// repo (read-only here) because code reads their field names.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { repoPath } from '../tools/paths.js';

const SCORING_PLACEHOLDERS = ['candidateName', 'homeLocations', 'company', 'roleTitle', 'jobLocation', 'jobUrl', 'locationNoteBlock', 'jobContentBlock'];
const HUNT_PLACEHOLDERS = ['candidateName', 'company', 'roleTitle', 'roleType', 'analysis', 'jobContentBlock', 'notesBlock'];

/** name -> label, default file, schema file (read-only), allowed and required placeholders. */
export const PROMPTS = {
  score: {
    label: 'Full-time scoring',
    usedBy: 'Scoring full-time jobs (npm run score, pipeline, UI Re-score)',
    file: ['agents', 'discovery', 'prompts', 'score.md'],
    schemaFile: ['agents', 'discovery', 'schemas', 'score.json'],
    allowed: SCORING_PLACEHOLDERS,
    required: ['company', 'roleTitle', 'jobContentBlock'],
  },
  'score-fractional': {
    label: 'Fractional scoring',
    usedBy: 'Scoring fractional jobs',
    file: ['agents', 'discovery', 'prompts', 'score-fractional.md'],
    schemaFile: ['agents', 'discovery', 'schemas', 'score-fractional.json'],
    allowed: [...SCORING_PLACEHOLDERS, 'stackingTarget', 'termsBlock'],
    required: ['company', 'roleTitle', 'jobContentBlock'],
  },
  'resume-tweaks': {
    label: 'Resume tweaks',
    usedBy: 'Writing resume tweaks for promoted jobs',
    file: ['agents', 'hunt', 'prompts', 'resume-tweaks.md'],
    allowed: HUNT_PLACEHOLDERS,
    required: ['company', 'roleTitle', 'analysis'],
  },
  'cover-letter': {
    label: 'Cover letter',
    usedBy: 'Writing cover letter bodies (the Doc adds the greeting and sign-off)',
    file: ['agents', 'hunt', 'prompts', 'cover-letter.md'],
    allowed: HUNT_PLACEHOLDERS,
    required: ['company', 'roleTitle', 'analysis'],
  },
};

export const MAX_TEMPLATE_CHARS = 20000;
const hash = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p ?? '');
  return h.digest('hex').slice(0, 10);
};

function definition(name) {
  const def = PROMPTS[name];
  if (!def) throw Object.assign(new Error(`Unknown prompt "${name}". Known: ${Object.keys(PROMPTS).join(', ')}`), { statusCode: 404 });
  return def;
}

/** The repo default for a prompt: { template, schema (object or null), schemaText }. */
export function defaultPrompt(name) {
  const def = definition(name);
  const template = readFileSync(repoPath(...def.file), 'utf8');
  const schemaText = def.schemaFile ? readFileSync(repoPath(...def.schemaFile), 'utf8') : null;
  return { template, schemaText, schema: schemaText ? JSON.parse(schemaText) : null };
}

/**
 * The prompt in effect: the active database edit if there is one, else the repo default.
 * version is a short hash of template + schema, stored with every score and artifact.
 * db may be null (tests, scripts without a database), which always gives the default.
 */
export function getPrompt(db, name) {
  const def = definition(name);
  const base = defaultPrompt(name);
  const row = db ? db.prepare('SELECT id, template, note, created_at FROM prompt_versions WHERE name = ? AND active = 1').get(name) : null;
  const template = row?.template ?? base.template;
  return {
    name,
    label: def.label,
    template,
    schema: base.schema,
    version: hash(template, base.schemaText),
    source: row ? 'custom' : 'default',
    versionId: row?.id ?? null,
    note: row?.note ?? null,
    updatedAt: row?.created_at ?? null,
  };
}

/** Placeholder names used in a template, in order of first appearance. */
export function placeholdersIn(template) {
  return [...new Set([...String(template).matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
}

/** Returns a list of problems that would break a run; empty when the template is safe to save. */
export function validateTemplate(name, template) {
  const def = definition(name);
  const problems = [];
  const t = String(template ?? '');
  if (!t.trim()) problems.push('The prompt is empty.');
  if (t.length > MAX_TEMPLATE_CHARS) problems.push(`The prompt is over ${MAX_TEMPLATE_CHARS.toLocaleString()} characters.`);
  if (/\{\{\s+\w+|\w+\s+\}\}/.test(t)) problems.push('Placeholders must not contain spaces inside the braces, e.g. {{company}}.');
  const used = placeholdersIn(t);
  const unknown = used.filter((p) => !def.allowed.includes(p));
  if (unknown.length) problems.push(`Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((p) => `{{${p}}}`).join(', ')}. Allowed: ${def.allowed.map((p) => `{{${p}}}`).join(', ')}.`);
  const missing = def.required.filter((p) => !used.includes(p));
  if (missing.length) problems.push(`Required placeholder${missing.length > 1 ? 's are' : ' is'} missing: ${missing.map((p) => `{{${p}}}`).join(', ')}.`);
  const stray = t.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, '').match(/\{\{|\}\}/g);
  if (stray) problems.push('There is an unmatched {{ or }}.');
  return problems;
}

/** Saves a new version and makes it active. Throws (statusCode 400) with the problems when invalid. */
export function savePrompt(db, name, { template, note }, now = new Date()) {
  const problems = validateTemplate(name, template);
  if (problems.length) throw Object.assign(new Error(problems.join(' ')), { statusCode: 400, problems });
  const current = getPrompt(db, name);
  if (current.template === template) return current;
  db.transaction(() => {
    db.prepare('UPDATE prompt_versions SET active = 0 WHERE name = ? AND active = 1').run(name);
    db.prepare('INSERT INTO prompt_versions (name, template, note, active, created_at) VALUES (?, ?, ?, 1, ?)').run(name, template, note?.trim() || null, now.toISOString());
  })();
  return getPrompt(db, name);
}

/** Makes an earlier version active again, or returns to the repo default when versionId is null. */
export function restorePrompt(db, name, versionId) {
  definition(name);
  db.transaction(() => {
    if (versionId != null) {
      const row = db.prepare('SELECT id FROM prompt_versions WHERE id = ? AND name = ?').get(versionId, name);
      if (!row) throw Object.assign(new Error(`Version ${versionId} of "${name}" not found.`), { statusCode: 404 });
    }
    db.prepare('UPDATE prompt_versions SET active = 0 WHERE name = ? AND active = 1').run(name);
    if (versionId != null) db.prepare('UPDATE prompt_versions SET active = 1 WHERE id = ?').run(versionId);
  })();
  return getPrompt(db, name);
}

/** Saved versions, newest first, with a hash matching what scores and artifacts record. */
export function listVersions(db, name) {
  const base = defaultPrompt(name);
  return db
    .prepare('SELECT id, template, note, active, created_at FROM prompt_versions WHERE name = ? ORDER BY id DESC')
    .all(name)
    .map((r) => ({ id: r.id, note: r.note, active: Boolean(r.active), createdAt: r.created_at, version: hash(r.template, base.schemaText), template: r.template }));
}
