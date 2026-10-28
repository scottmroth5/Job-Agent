// Each user's resumes (Settings > Resumes): the uploaded file, its text, a label, and the plain words of the job titles
// it is for. pickResume chooses the one a job's letter, resume tweaks, and meeting prep are written from: the resume
// whose words match the job title best, else the default, else the only one. withResume adds its text to the
// background those calls read. Every query names user_id (db/user-tables.js lists resumes).
import { randomUUID } from 'node:crypto';
import { documentText } from '../tools/doc-text.js';

export const MAX_RESUMES = 10;
const MAX_LABEL = 60;
const MAX_TITLES = 300;

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 1);
const cleanTitles = (s) => String(s ?? '').split(/[,\n]/).map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean).join(', ').slice(0, MAX_TITLES);
const cleanLabel = (s, fallback) => (String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL) || fallback);

const row = (r) =>
  r && {
    id: r.id,
    label: r.label,
    titles: r.titles,
    isDefault: Boolean(r.is_default),
    filename: r.filename,
    kind: r.kind,
    sizeBytes: r.size_bytes,
    chars: r.chars ?? r.text?.length ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

const COLUMNS = 'id, label, titles, is_default, filename, kind, size_bytes, LENGTH(text) AS chars, created_at, updated_at';

/** The current user's resumes, default first, then newest. */
export function listResumes(db) {
  return db.prepare(`SELECT ${COLUMNS} FROM resumes WHERE user_id = @uid ORDER BY is_default DESC, created_at DESC`).all().map(row);
}

export function getResume(db, id) {
  return row(db.prepare(`SELECT ${COLUMNS} FROM resumes WHERE id = ? AND user_id = @uid`).get(id)) ?? null;
}

/** The file for a download: { filename, kind, file, text } or null. */
export function resumeFile(db, id) {
  return db.prepare('SELECT filename, kind, file, text FROM resumes WHERE id = ? AND user_id = @uid').get(id) ?? null;
}

const clearDefault = (db) => db.prepare('UPDATE resumes SET is_default = 0 WHERE user_id = @uid AND is_default = 1').run();

/** Stores an upload; the first one becomes the default. Returns the new resume. */
export async function addResume(db, { bytes, filename, label, titles, now = new Date() }) {
  if (db.prepare('SELECT COUNT(*) FROM resumes WHERE user_id = @uid').pluck().get() >= MAX_RESUMES) {
    throw bad(`Keep at most ${MAX_RESUMES} resumes: delete one you no longer use first.`);
  }
  const { kind, text } = await documentText(bytes, filename);
  const id = randomUUID();
  const iso = now.toISOString();
  const first = !db.prepare('SELECT 1 FROM resumes WHERE user_id = @uid').get();
  const name = String(filename || 'resume').slice(0, 200);
  db.prepare(`INSERT INTO resumes (id, user_id, label, titles, is_default, filename, kind, size_bytes, file, text, created_at, updated_at)
      VALUES (?, @uid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, cleanLabel(label, name.replace(/\.[a-z]+$/i, '')), cleanTitles(titles), first ? 1 : 0, name, kind, bytes.length, bytes, text, iso, iso);
  return getResume(db, id);
}

/** A new file for an existing resume (its label, titles, and default stay). */
export async function replaceResumeFile(db, id, { bytes, filename, now = new Date() }) {
  if (!getResume(db, id)) throw bad('Resume not found.', 404);
  const { kind, text } = await documentText(bytes, filename);
  db.prepare('UPDATE resumes SET filename = ?, kind = ?, size_bytes = ?, file = ?, text = ?, updated_at = ? WHERE id = ? AND user_id = @uid').run(
    String(filename || 'resume').slice(0, 200),
    kind,
    bytes.length,
    bytes,
    text,
    now.toISOString(),
    id,
  );
  return getResume(db, id);
}

/** Label, titles, and default (making one the default clears the others). */
export function updateResume(db, id, { label, titles, isDefault }, now = new Date()) {
  const r = getResume(db, id);
  if (!r) throw bad('Resume not found.', 404);
  if (isDefault === true) clearDefault(db);
  db.prepare('UPDATE resumes SET label = ?, titles = ?, is_default = ?, updated_at = ? WHERE id = ? AND user_id = @uid').run(
    label === undefined ? r.label : cleanLabel(label, r.label),
    titles === undefined ? r.titles : cleanTitles(titles),
    isDefault === undefined ? (r.isDefault ? 1 : 0) : isDefault ? 1 : 0,
    now.toISOString(),
    id,
  );
  return getResume(db, id);
}

/** Deletes one; when it was the default, the newest remaining one becomes the default. */
export function deleteResume(db, id) {
  const r = getResume(db, id);
  if (!r) throw bad('Resume not found.', 404);
  db.prepare('DELETE FROM resumes WHERE id = ? AND user_id = @uid').run(id);
  if (r.isDefault) {
    const next = db.prepare('SELECT id FROM resumes WHERE user_id = @uid ORDER BY created_at DESC LIMIT 1').pluck().get();
    if (next) db.prepare('UPDATE resumes SET is_default = 1 WHERE id = ? AND user_id = @uid').run(next);
  }
}

/**
 * The resume for a job: the one whose titles share the most words with the job title (each listed title counts when
 * all its words appear), else the default, else the only one; null when the user has none. Returns its text too.
 */
export function pickResume(db, jobTitle) {
  const all = db.prepare('SELECT id, label, titles, is_default, text FROM resumes WHERE user_id = @uid ORDER BY is_default DESC, created_at DESC').all();
  if (!all.length) return null;
  const title = new Set(words(jobTitle));
  let best = null;
  let bestScore = 0;
  for (const r of all) {
    let score = 0;
    for (const t of r.titles.split(',')) {
      const ws = words(t);
      if (ws.length && ws.every((w) => title.has(w))) score = Math.max(score, ws.length);
    }
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  const chosen = best ?? all.find((r) => r.is_default) ?? (all.length === 1 ? all[0] : all[0]);
  return { id: chosen.id, label: chosen.label, text: chosen.text, matched: Boolean(best) };
}

/** The background with the chosen resume after it, for letters, tweaks, and meeting prep. */
export function withResume(background, resume) {
  if (!resume) return background;
  return `${background}\n\n## Resume to work from: ${resume.label}\nThis is the resume the candidate will send for this job. Base resume tweaks on it, and keep facts in letters and preps consistent with it.\n\n${resume.text}`;
}
