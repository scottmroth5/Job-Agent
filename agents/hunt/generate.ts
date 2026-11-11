// Resume tweaks and cover letters for promoted jobs. Sonnet 5.5 writes both with the Candidate
// Knowledge doc as the cached system prompt; letters get v1's cleanup and rule checks, then are
// saved as Google Docs. Nothing existing is ever overwritten.
import { fillTemplate } from '../../tools/template.ts';
import { sanitizeDashes, truncate } from '../../tools/text.ts';
import { letterHeader } from '../letter-header.ts';
import { ensureLetterFolder } from '../../tools/google/drive.ts';
import { getPrompt } from '../prompts.ts';
import { PROMOTE_AT } from '../discovery/score.ts';
import { runCheck } from '../letter-checks.ts';
import { roleTypeText, formatAnalysis, stripSalutationAndSignoff, checkCoverLetter, letterDocName, letterHtml } from './letters.ts';
import { lookups, sqlList } from '../lookups.ts';
import { pickResume, withResume } from '../resumes.ts';
import type { Claude, Run, SendOptions } from '@scottmroth5/agent-core';
import type { Database, JobStore } from '../../tools/types.ts';
import type { JobSearchConfig } from '../../tools/config.ts';
import type { DriveClient } from '../../tools/google/drive.ts';
import type { PostingsRow } from '../../db/types.ts';
import type { AnalysisFields } from './letters.ts';

/** The settings letters read: the candidate's names and the cover letter checks. */
export type LetterConfig = { candidate: JobSearchConfig['candidate']; coverLetterChecks?: JobSearchConfig['coverLetterChecks'] };

/** The posting fields the hunt prompts read. */
export type PromptPosting = Pick<PostingsRow, 'company' | 'title' | 'jd_text' | 'fetched_text' | 'notes'>;

/** A posting selectForHunt returns: its row, its latest v2 analysis and score, and what already exists. */
export type HuntPosting = PostingsRow & {
  analysis_json: string | null;
  v2_score: number | null;
  has_tweaks: number;
  has_letter: number;
  letter_missing_doc: number | null;
};

/** The prompt templates the two requests fill. */
type HuntTemplates = { tweaks: { template: string }; letter: { template: string } };

export const HUNT_MODEL = 'claude-sonnet-5-5';
// Writing quality matters more here than in scoring, so medium effort; thinking counts toward maxTokens.
export const HUNT_SETTINGS = { maxTokens: 12000, effort: 'medium' };
const CONTENT_CHARS = 6000;
const MIN_NOTES = 30;

/** Both hunt prompts in effect (admin-screen edits or the repo defaults), with short version hashes. */
export async function loadHuntPrompts(db: Database | null = null) {
  const load = async (name: string) => {
    const p = await getPrompt(db, name);
    return { template: p.template, version: p.version, source: p.source };
  };
  return { tweaks: await load('resume-tweaks'), letter: await load('cover-letter') };
}

/** Postings eligible for tweaks/letters, with their latest v2 analysis and what already exists. */
export async function selectForHunt(db: Database, { ids, promoteAt = PROMOTE_AT }: { ids?: number[] | null; promoteAt?: number } = {}): Promise<HuntPosting[]> {
  const base = `SELECT p.*,
      (SELECT analysis_json FROM scores s WHERE s.posting_id = p.id AND s.user_id = p.user_id AND s.source IN ('v2', 'v2-rule') ORDER BY s.id DESC LIMIT 1) AS analysis_json,
      (SELECT score FROM scores s WHERE s.posting_id = p.id AND s.user_id = p.user_id AND s.source IN ('v2', 'v2-rule') ORDER BY s.id DESC LIMIT 1) AS v2_score,
      EXISTS (SELECT 1 FROM artifacts a WHERE a.posting_id = p.id AND a.user_id = p.user_id AND a.kind = 'resume_tweaks' AND a.source = 'v2') AS has_tweaks,
      EXISTS (SELECT 1 FROM artifacts a WHERE a.posting_id = p.id AND a.user_id = p.user_id AND a.kind = 'cover_letter' AND a.source = 'v2') AS has_letter,
      (SELECT a.id FROM artifacts a WHERE a.posting_id = p.id AND a.user_id = p.user_id AND a.kind = 'cover_letter' AND a.source = 'v2'
         AND a.doc_id IS NULL ORDER BY a.id DESC LIMIT 1) AS letter_missing_doc
    FROM (SELECT * FROM postings WHERE user_id = @uid) p`;
  if (ids?.length) return db.prepare(`${base} WHERE p.id IN (${ids.map(() => '?').join(', ')}) ORDER BY p.id`).all(...ids) as HuntPosting[];
  return db
    .prepare(`SELECT * FROM (${base} WHERE p.stage IN ${sqlList((await lookups(db)).ids('stage', 'active'))} AND p.status IN ${sqlList((await lookups(db)).ids('status', 'evaluate', 'waiting'))})
      WHERE v2_score >= ? AND (has_tweaks = 0 OR has_letter = 0 OR letter_missing_doc IS NOT NULL) ORDER BY id`)
    .all(promoteAt) as HuntPosting[];
}

function promptValues(posting: PromptPosting, analysis: AnalysisFields, config: LetterConfig) {
  const text = (posting.jd_text || posting.fetched_text || '').trim();
  return {
    candidateName: config.candidate.name,
    company: posting.company,
    roleTitle: posting.title,
    roleType: roleTypeText(posting.title),
    analysis: formatAnalysis(analysis),
    jobContentBlock: text ? `Job posting:\n${truncate(text, CONTENT_CHARS)}\n\n` : '',
    notesBlock: posting.notes && posting.notes.length > MIN_NOTES ? `Candidate's notes about this role:\n${posting.notes}\n\n` : '',
  };
}

/** claude.send options for resume tweaks. */
export function buildTweaksRequest(posting: PromptPosting, analysis: AnalysisFields, { config, knowledge, prompts }: { config: LetterConfig; knowledge: string; prompts: HuntTemplates }) {
  return { model: HUNT_MODEL, system: knowledge, prompt: fillTemplate(prompts.tweaks.template, promptValues(posting, analysis, config)), label: 'resume-tweaks', ...HUNT_SETTINGS };
}

/** claude.send options for a cover letter body. */
export function buildLetterRequest(posting: PromptPosting, analysis: AnalysisFields, { config, knowledge, prompts }: { config: LetterConfig; knowledge: string; prompts: HuntTemplates }) {
  return { model: HUNT_MODEL, system: knowledge, prompt: fillTemplate(prompts.letter.template, promptValues(posting, analysis, config)), label: 'cover-letter', ...HUNT_SETTINGS };
}

// The cover letter prompt asks for under 350 words; models run over, so it is checked in code.
export const MAX_LETTER_WORDS = 350;

/** Cleans a letter body and returns { body, flags }. */
export function finishLetter(text: string, config: LetterConfig) {
  const body = sanitizeDashes(stripSalutationAndSignoff(text, [config.candidate.name, config.candidate.signoffName]));
  const flags = checkCoverLetter(body, config.coverLetterChecks ?? []);
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > MAX_LETTER_WORDS) flags.push(`${words} words (limit ${MAX_LETTER_WORDS})`);
  return { body, flags };
}

const longDate = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

/**
 * Generates what each selected posting is missing: resume tweaks, a cover letter, or just the
 * letter's Google Doc (when an earlier save failed). drive is createDriveClient(), or null to skip Docs.
 */
export async function generateForPostings({ store, config, claude, knowledge, drive, run, now = new Date(), options = {} }: {
  store: Pick<JobStore, 'db'>;
  config: LetterConfig;
  claude: Claude;
  knowledge: string;
  drive: DriveClient | null;
  run?: Run | null;
  now?: Date;
  options?: { ids?: number[] | null; regenerate?: boolean; promoteAt?: number; maxConsecutiveFailures?: number };
}) {
  const { ids, regenerate = false, promoteAt = PROMOTE_AT, maxConsecutiveFailures = 3 } = options;
  const { db } = store;
  const prompts = await loadHuntPrompts(db);
  const postings = await selectForHunt(db, { ids, promoteAt });

  const insertArtifact = db.prepare(`INSERT INTO artifacts (user_id, posting_id, kind, content, flags_json, source, model, prompt_version, run_id, created_at, resume_id)
    VALUES (@uid, ?, ?, ?, ?, 'v2', ?, ?, ?, ?, ?)`);
  const setDoc = db.prepare('UPDATE artifacts SET doc_id = ?, doc_url = ?, doc_name = ? WHERE id = ? AND user_id = @uid');
  const letterById = db.prepare('SELECT content FROM artifacts WHERE id = ? AND user_id = @uid');

  const summary = {
    selected: postings.length,
    tweaks: 0,
    letters: 0,
    checked: 0,
    claimFlags: 0,
    docs: 0,
    docFailures: [] as Array<{ id: number; error: string }>,
    flagged: [] as Array<{ id: number; flags: string[] }>,
    skipped: [] as Array<{ id: number; reason: string }>,
    failures: [] as Array<{ id: number; error: string }>,
    aborted: false,
  };
  let consecutive = 0;
  let folderId: string | null = null;

  const saveDoc = async (posting: HuntPosting, artifactId: number, body: string) => {
    if (!drive) return;
    try {
      folderId ??= await ensureLetterFolder(drive, db);
      const name = letterDocName((await letterHeader(db, config)).name, posting.title, posting.company);
      const html = letterHtml({ candidate: await letterHeader(db, config), company: posting.company, title: posting.title, date: longDate(now), body });
      const doc = await drive.createDocFromHtml({ name, html, folderId });
      setDoc.run(doc.id, doc.url, name, artifactId);
      summary.docs += 1;
      run?.log?.('info', `#${posting.id}: letter saved as a Google Doc`);
    } catch (err) {
      const e = err as Error;
      summary.docFailures.push({ id: posting.id, error: `${e.name}: ${e.message}` });
    }
  };

  const call = async (request: Omit<SendOptions, 'trace'>) => {
    const res = await claude.send({ ...request, trace: run });
    consecutive = 0;
    return res.text;
  };

  const log = (msg: string) => run?.log?.('info', msg);
  log(postings.length ? `${postings.length} promoted jobs need tweaks, a letter, or a letter Doc` : 'Nothing to write');
  for (const [i, p] of postings.entries()) {
    if (summary.aborted) break;
    if (!p.analysis_json) {
      summary.skipped.push({ id: p.id, reason: 'no v2 score' });
      continue;
    }
    const analysis = JSON.parse(p.analysis_json);
    const nowIso = new Date().toISOString();
    const tag = `#${p.id} (${i + 1}/${postings.length})`;
    // The user's resume for this job (agents/resumes.ts), read with the background; none uploaded means the background alone.
    const resume = pickResume(db, p.title);
    const background = withResume(knowledge, resume);
    try {
      if (!p.has_tweaks || regenerate) {
        log(`${tag}: writing resume tweaks`);
        const tweaks = sanitizeDashes(await call(buildTweaksRequest(p, analysis, { config, knowledge: background, prompts })));
        insertArtifact.run(p.id, 'resume_tweaks', tweaks, null, HUNT_MODEL, prompts.tweaks.version, run?.id ?? null, nowIso, resume?.id ?? null);
        summary.tweaks += 1;
      }
      if (p.letter_missing_doc && !regenerate) {
        log(`${tag}: saving the earlier letter as a Google Doc`);
        await saveDoc(p, p.letter_missing_doc, (letterById.get(p.letter_missing_doc) as { content: string }).content);
      } else if (!p.has_letter || regenerate) {
        log(`${tag}: writing cover letter`);
        const { body, flags } = finishLetter(await call(buildLetterRequest(p, analysis, { config, knowledge: background, prompts })), config);
        const artifactId = Number(
          insertArtifact.run(p.id, 'cover_letter', body, flags.length ? JSON.stringify(flags) : null, HUNT_MODEL, prompts.letter.version, run?.id ?? null, nowIso, resume?.id ?? null).lastInsertRowid,
        );
        summary.letters += 1;
        if (flags.length) summary.flagged.push({ id: p.id, flags });
        // The fact check (agents/letter-checks.ts) never throws: a failure is saved as not checked and the letter stays.
        const check = await runCheck({ db, claude, background, posting: p, artifactId, letter: body, config, trace: run });
        if (check.check?.status === 'checked') {
          summary.checked += 1;
          summary.claimFlags += check.flagged;
          log(`${tag}: letter fact check: ${check.flagged} to look at`);
        }
        await saveDoc(p, artifactId, body);
      }
    } catch (err) {
      consecutive += 1;
      const e = err as Error;
      summary.failures.push({ id: p.id, error: `${e.name}: ${e.message}` });
      run?.log?.('warn', `Hunt generation failed for posting ${p.id}: ${e.name}`);
      if (consecutive >= maxConsecutiveFailures) summary.aborted = true;
    }
  }
  return summary;
}

/** Rough cost estimate: two Sonnet calls per posting that needs both. */
export function estimateHuntCost(postings: Array<Pick<HuntPosting, 'has_tweaks' | 'has_letter' | 'jd_text' | 'fetched_text'>>, knowledgeChars: number) {
  let usd = 0;
  for (const p of postings) {
    const calls = (p.has_tweaks ? 0 : 1) + (p.has_letter ? 0 : 1);
    const inputTokens = (knowledgeChars + 2500 + Math.min((p.jd_text || p.fetched_text || '').length, CONTENT_CHARS)) / 4;
    usd += calls * ((inputTokens * 2 + 2000 * 10) / 1_000_000); // ~2000 output tokens including thinking
  }
  return usd;
}
