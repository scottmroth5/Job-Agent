// The editable prompts. Repo files are the defaults; admin-screen edits are stored in the
// database (prompt_versions) with history, and the active edit wins. Output schemas stay in the
// repo (read-only here) because code reads their field names.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { repoPath } from '../tools/paths.ts';
import type { Db } from '../db/engine/types.ts';

/** One editable prompt: where its default lives and which placeholders it may and must use. */
export interface PromptDefinition {
  label: string;
  usedBy: string;
  file: string[];
  schemaFile?: string[];
  allowed: string[];
  required: string[];
}

/** The prompt in effect, as getPrompt returns it. */
export interface Prompt {
  name: string;
  label: string;
  template: string;
  schema: object | null;
  version: string;
  source: 'custom' | 'default';
  versionId: number | null;
  note: string | null;
  updatedAt: string | null;
}

const SCORING_PLACEHOLDERS = ['candidateName', 'homeLocations', 'company', 'roleTitle', 'jobLocation', 'jobUrl', 'locationNoteBlock', 'jobContentBlock'];
const HUNT_PLACEHOLDERS = ['candidateName', 'company', 'roleTitle', 'roleType', 'analysis', 'jobContentBlock', 'notesBlock'];

/** name -> label, default file, schema file (read-only), allowed and required placeholders. */
export const PROMPTS: Record<string, PromptDefinition> = {
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
  'verify-letter': {
    label: 'Cover letter fact check',
    usedBy: 'Checking each claim a cover letter makes about you against your knowledge doc and resume (after a letter is written or saved)',
    file: ['agents', 'hunt', 'prompts', 'verify-letter.md'],
    schemaFile: ['agents', 'hunt', 'schemas', 'verify-letter.json'],
    allowed: ['candidateName', 'company', 'roleTitle', 'letterBlock', 'jobContentBlock'],
    required: ['letterBlock'],
  },
  'meeting-prep': {
    label: 'Meeting prep',
    usedBy: 'Writing meeting prep documents from a job (Prepare for a meeting in the job panel)',
    file: ['agents', 'hunt', 'prompts', 'meeting-prep.md'],
    allowed: ['candidateName', 'company', 'roleTitle', 'today', 'meetingBlock', 'attendeesBlock', 'contextBlock', 'notesBlock', 'analysisBlock', 'letterBlock', 'jobContentBlock', 'researchBlock'],
    required: ['company', 'attendeesBlock'],
  },
  'find-contact': {
    label: 'Find someone to contact',
    usedBy: 'Finding the hiring manager or recruiter for an application with no reply, and drafting a short note (the job panel)',
    file: ['agents', 'hunt', 'prompts', 'find-contact.md'],
    allowed: ['candidateName', 'company', 'roleTitle', 'today', 'appliedBlock', 'notesBlock', 'analysisBlock', 'jobContentBlock'],
    required: ['company', 'roleTitle'],
  },
  'inbox-classify': {
    label: 'Inbox email classification',
    usedBy: 'Classifying job emails from Gmail (npm run inbox); the untrusted-email rules are fixed in code',
    file: ['agents', 'inbox', 'prompts', 'classify.md'],
    schemaFile: ['agents', 'inbox', 'schemas', 'classify.json'],
    allowed: ['applicationsBlock', 'emailBlock'],
    required: ['applicationsBlock', 'emailBlock'],
  },
};

export const MAX_TEMPLATE_CHARS = 20000;
const hash = (...parts: Array<string | null | undefined>) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p ?? '');
  return h.digest('hex').slice(0, 10);
};

function definition(name: string): PromptDefinition {
  const def = PROMPTS[name];
  if (!def) throw Object.assign(new Error(`Unknown prompt "${name}". Known: ${Object.keys(PROMPTS).join(', ')}`), { statusCode: 404 });
  return def;
}

/** The repo default for a prompt: { template, schema (object or null), schemaText }. */
export function defaultPrompt(name: string) {
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
export async function getPrompt(db: Db | null | undefined, name: string): Promise<Prompt> {
  const def = definition(name);
  const base = defaultPrompt(name);
  const row = db
    ? ((await db.prepare('SELECT id, template, note, created_at FROM prompt_versions WHERE name = ? AND user_id = @uid AND active = 1').get(name)) as
        | { id: number; template: string; note: string | null; created_at: string }
        | undefined)
    : null;
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
export function placeholdersIn(template: unknown): string[] {
  return [...new Set([...String(template).matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1] as string))];
}

/** Returns a list of problems that would break a run; empty when the template is safe to save. */
export function validateTemplate(name: string, template: unknown) {
  const def = definition(name);
  const problems: string[] = [];
  const t = String(template ?? '');
  if (!t.trim()) problems.push('The prompt is empty.');
  if (t.length > MAX_TEMPLATE_CHARS) problems.push(`The prompt is over ${MAX_TEMPLATE_CHARS.toLocaleString()} characters.`);
  if (/\{\{\s|\s\}\}/.test(t)) problems.push('Placeholders must not contain spaces inside the braces, e.g. {{company}}.');
  const used = placeholdersIn(t);
  const unknown = used.filter((p) => !def.allowed.includes(p));
  if (unknown.length) problems.push(`Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((p) => `{{${p}}}`).join(', ')}. Allowed: ${def.allowed.map((p) => `{{${p}}}`).join(', ')}.`);
  const missing = def.required.filter((p) => !used.includes(p));
  if (missing.length) problems.push(`Required placeholder${missing.length > 1 ? 's are' : ' is'} missing: ${missing.map((p) => `{{${p}}}`).join(', ')}.`);
  const stray = t.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, '').match(/\{\{|\}\}/g);
  if (stray) problems.push('There is an unmatched {{ or }}.');
  return problems;
}

/**
 * Saves a new version and makes it active. Throws (statusCode 400) with the problems when invalid. The comparison with
 * the active version and the save are one transaction.
 */
export async function savePrompt(db: Db, name: string, { template, note }: { template: string; note?: string | null }, now = new Date()) {
  const problems = validateTemplate(name, template);
  if (problems.length) throw Object.assign(new Error(problems.join(' ')), { statusCode: 400, problems });
  const q = db;
  return q.tx(async () => {
    const current = await getPrompt(q, name);
    if (current.template === template) return current;
    await q.prepare('UPDATE prompt_versions SET active = 0 WHERE name = ? AND user_id = @uid AND active = 1').run(name);
    await q.prepare('INSERT INTO prompt_versions (user_id, name, template, note, active, created_at) VALUES (@uid, ?, ?, ?, 1, ?)').run(name, template, note?.trim() || null, now.toISOString());
    return await getPrompt(q, name);
  });
}

/** Makes an earlier version active again, or returns to the repo default when versionId is null. */
export async function restorePrompt(db: Db, name: string, versionId: number | null) {
  definition(name);
  const q = db;
  return q.tx(async () => {
    if (versionId != null) {
      const row = await q.prepare('SELECT id FROM prompt_versions WHERE id = ? AND name = ? AND user_id = @uid').get(versionId, name);
      if (!row) throw Object.assign(new Error(`Version ${versionId} of "${name}" not found.`), { statusCode: 404 });
    }
    await q.prepare('UPDATE prompt_versions SET active = 0 WHERE name = ? AND user_id = @uid AND active = 1').run(name);
    if (versionId != null) await q.prepare('UPDATE prompt_versions SET active = 1 WHERE id = ? AND user_id = @uid').run(versionId);
    return await getPrompt(q, name);
  });
}

/** The version hash a template has (what scores and artifacts record), for a template not yet saved. */
export const versionOf = (name: string, template: string) => hash(template, defaultPrompt(name).schemaText);

/**
 * What a recorded prompt version was, for the job panel's score details: the repo default, one of the user's saved
 * edits (with its note and date), or one no longer known (the default text has changed since); and whether it is the
 * prompt in use now. null when nothing was recorded ('default' rows from before versions were hashed).
 */
export async function describeVersion(db: Db, name: string, version: string | null | undefined) {
  if (!version || version === 'default') return null;
  const saved = (await listVersions(db, name)).find((v) => v.version === version);
  const kind = version === versionOf(name, defaultPrompt(name).template) ? 'default' : saved ? 'edit' : 'earlier';
  return { name, version, kind, note: saved?.note ?? null, editedAt: saved?.createdAt ?? null, current: (await getPrompt(db, name)).version === version };
}

/** Saved versions, newest first, with a hash matching what scores and artifacts record. */
export async function listVersions(db: Db, name: string) {
  const base = defaultPrompt(name);
  return ((await db
    .prepare('SELECT id, template, note, active, created_at FROM prompt_versions WHERE name = ? AND user_id = @uid ORDER BY id DESC')
    .all(name)) as Array<{ id: number; template: string; note: string | null; active: number; created_at: string }>)
    .map((r) => ({ id: r.id, note: r.note, active: Boolean(r.active), createdAt: r.created_at, version: hash(r.template, base.schemaText), template: r.template }));
}
