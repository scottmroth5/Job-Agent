// Each user's resumes (Settings > Resumes): the uploaded file, its text, a label, and the plain words of the job titles
// it is for. pickResume chooses the one a job's letter, resume tweaks, and meeting prep are written from: the resume
// whose words match the job title best, else the default, else the only one. withResume adds its text to the
// background those calls read. Every query names user_id (db/user-tables.ts lists resumes).
import { randomUUID } from 'node:crypto';
import { documentText } from '../tools/doc-text.ts';
import type { Db } from '../tools/types.ts';
import type { ResumesRow } from '../db/types.ts';

/** A resume as Settings shows it (never the file or its text). */
export interface Resume {
  id: string;
  label: string;
  titles: string;
  isDefault: boolean;
  filename: string;
  kind: string;
  sizeBytes: number;
  chars: number;
  createdAt: string;
  updatedAt: string;
}

/** What listResumes and getResume read: the row without the file and text, plus the text's length. */
type ResumeListRow = Omit<ResumesRow, 'file' | 'text' | 'user_id'> & { chars: number | null; text?: string };

export const MAX_RESUMES = 10;
const MAX_LABEL = 60;
const MAX_TITLES = 300;

const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const words = (s: string | null | undefined) => String(s ?? '').toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 1);
const cleanTitles = (s: unknown) => String(s ?? '').split(/[,\n]/).map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean).join(', ').slice(0, MAX_TITLES);
const cleanLabel = (s: unknown, fallback: string) => (String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL) || fallback);

// A missing row passes through as is (undefined), so callers can say ?? null.
const row = (r: ResumeListRow | undefined): Resume | undefined =>
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
export async function listResumes(db: Db) {
  return (await db.prepare(`SELECT ${COLUMNS} FROM resumes WHERE user_id = @uid ORDER BY is_default DESC, created_at DESC`).all() as ResumeListRow[]).map(row) as Resume[];
}

export async function getResume(db: Db, id: string): Promise<Resume | null> {
  return row(await db.prepare(`SELECT ${COLUMNS} FROM resumes WHERE id = ? AND user_id = @uid`).get(id) as ResumeListRow | undefined) ?? null;
}

/** The file for a download: { filename, kind, file, text } or null. */
export async function resumeFile(db: Db, id: string) {
  return (await db.prepare('SELECT filename, kind, file, text FROM resumes WHERE id = ? AND user_id = @uid').get(id) as Pick<ResumesRow, 'filename' | 'kind' | 'file' | 'text'> | undefined) ?? null;
}

const clearDefault = async (db: Db) => await db.prepare('UPDATE resumes SET is_default = 0 WHERE user_id = @uid AND is_default = 1').run();

/** Stores an upload; the first one becomes the default. Returns the new resume. */
export async function addResume(db: Db, { bytes, filename, label, titles, now = new Date() }: { bytes: Buffer; filename?: string | null; label?: unknown; titles?: unknown; now?: Date }) {
  const full = async () => ((await db.prepare('SELECT COUNT(*) FROM resumes WHERE user_id = @uid').pluck().get()) as number) >= MAX_RESUMES;
  const tooMany = () => bad(`Keep at most ${MAX_RESUMES} resumes: delete one you no longer use first.`);
  if (await full()) throw tooMany(); // before reading the file
  const { kind, text } = await documentText(bytes, filename);
  const id = randomUUID();
  const iso = now.toISOString();
  const name = String(filename || 'resume').slice(0, 200);
  // The count, the first-one check, and the insert are one transaction (the file is read before it).
  await db.tx(async () => {
    if (await full()) throw tooMany();
    const first = !(await db.prepare('SELECT 1 FROM resumes WHERE user_id = @uid').get());
    await db
      .prepare(`INSERT INTO resumes (id, user_id, label, titles, is_default, filename, kind, size_bytes, file, text, created_at, updated_at)
      VALUES (?, @uid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, cleanLabel(label, name.replace(/\.[a-z]+$/i, '')), cleanTitles(titles), first ? 1 : 0, name, kind, bytes.length, bytes, text, iso, iso);
  });
  return await getResume(db, id);
}

/** A new file for an existing resume (its label, titles, and default stay). */
export async function replaceResumeFile(db: Db, id: string, { bytes, filename, now = new Date() }: { bytes: Buffer; filename?: string | null; now?: Date }) {
  if (!(await getResume(db, id))) throw bad('Resume not found.', 404);
  const { kind, text } = await documentText(bytes, filename);
  // The UPDATE names the resume, so one deleted while the file was read is simply not changed.
  await db.prepare('UPDATE resumes SET filename = ?, kind = ?, size_bytes = ?, file = ?, text = ?, updated_at = ? WHERE id = ? AND user_id = @uid').run(
    String(filename || 'resume').slice(0, 200),
    kind,
    bytes.length,
    bytes,
    text,
    now.toISOString(),
    id,
  );
  return await getResume(db, id);
}

/** Label, titles, and default (making one the default clears the others). */
export async function updateResume(db: Db, id: string, { label, titles, isDefault }: { label?: unknown; titles?: unknown; isDefault?: boolean }, now = new Date()) {
  // The read, the default change, and the update are one transaction.
  return db.tx(async () => {
    const r = await getResume(db, id);
    if (!r) throw bad('Resume not found.', 404);
    if (isDefault === true) await clearDefault(db);
    await db.prepare('UPDATE resumes SET label = ?, titles = ?, is_default = ?, updated_at = ? WHERE id = ? AND user_id = @uid').run(
      label === undefined ? r.label : cleanLabel(label, r.label),
      titles === undefined ? r.titles : cleanTitles(titles),
      isDefault === undefined ? (r.isDefault ? 1 : 0) : isDefault ? 1 : 0,
      now.toISOString(),
      id,
    );
    return await getResume(db, id);
  });
}

/** Deletes one; when it was the default, the newest remaining one becomes the default. */
export async function deleteResume(db: Db, id: string) {
  // The delete and choosing the next default are one transaction.
  return db.tx(async () => {
    const r = await getResume(db, id);
    if (!r) throw bad('Resume not found.', 404);
    await db.prepare('DELETE FROM resumes WHERE id = ? AND user_id = @uid').run(id);
    if (r.isDefault) {
      const next = await db.prepare('SELECT id FROM resumes WHERE user_id = @uid ORDER BY created_at DESC LIMIT 1').pluck().get();
      if (next) await db.prepare('UPDATE resumes SET is_default = 1 WHERE id = ? AND user_id = @uid').run(next);
    }
  });
}

/**
 * The resume for a job: the one whose titles share the most words with the job title (each listed title counts when
 * all its words appear), else the default, else the only one; null when the user has none. Returns its text too.
 */
export async function pickResume(db: Db, jobTitle: string | null | undefined): Promise<ChosenResume | null> {
  const all = await db.prepare('SELECT id, label, titles, is_default, text FROM resumes WHERE user_id = @uid ORDER BY is_default DESC, created_at DESC').all() as Array<Pick<ResumesRow, 'id' | 'label' | 'titles' | 'is_default' | 'text'>>;
  if (!all.length) return null;
  const title = new Set(words(jobTitle));
  let best: (typeof all)[number] | null = null;
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
  const chosen = (best ?? all.find((r) => r.is_default) ?? (all.length === 1 ? all[0] : all[0])) as (typeof all)[number];
  return { id: chosen.id, label: chosen.label, text: chosen.text, matched: Boolean(best) };
}

/** pickResume's choice: the resume and its text, and whether a title matched. */
export interface ChosenResume {
  id: string;
  label: string;
  text: string;
  matched: boolean;
}

/** The background with the chosen resume after it, for letters, tweaks, and meeting prep. */
export function withResume(background: string, resume: ChosenResume | null | undefined) {
  if (!resume) return background;
  return `${background}\n\n## Resume to work from: ${resume.label}\nThis is the resume the candidate will send for this job. Base resume tweaks on it, and keep facts in letters and preps consistent with it.\n\n${resume.text}`;
}
