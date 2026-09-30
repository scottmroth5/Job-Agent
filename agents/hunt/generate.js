// Resume tweaks and cover letters for promoted jobs. Sonnet 5.5 writes both with the Candidate
// Knowledge doc as the cached system prompt; letters get v1's cleanup and rule checks, then are
// saved as Google Docs. Nothing existing is ever overwritten.
import { fillTemplate } from '../../tools/template.js';
import { sanitizeDashes, truncate } from '../../tools/text.js';
import { ensureLetterFolder } from '../../tools/google/drive.js';
import { getPrompt } from '../prompts.js';
import { PROMOTE_AT } from '../discovery/score.js';
import { roleTypeText, formatAnalysis, stripSalutationAndSignoff, checkCoverLetter, letterDocName, letterHtml } from './letters.js';

export const HUNT_MODEL = 'claude-sonnet-5-5';
// Writing quality matters more here than in scoring, so medium effort; thinking counts toward maxTokens.
export const HUNT_SETTINGS = { maxTokens: 12000, effort: 'medium' };
const CONTENT_CHARS = 6000;
const MIN_NOTES = 30;

/** Both hunt prompts in effect (admin-screen edits or the repo defaults), with short version hashes. */
export function loadHuntPrompts(db = null) {
  const load = (name) => {
    const p = getPrompt(db, name);
    return { template: p.template, version: p.version, source: p.source };
  };
  return { tweaks: load('resume-tweaks'), letter: load('cover-letter') };
}

/** Postings eligible for tweaks/letters, with their latest v2 analysis and what already exists. */
export function selectForHunt(db, { ids, promoteAt = PROMOTE_AT } = {}) {
  const base = `SELECT p.*,
      (SELECT analysis_json FROM scores s WHERE s.posting_id = p.id AND s.source IN ('v2', 'v2-rule') ORDER BY s.id DESC LIMIT 1) AS analysis_json,
      (SELECT score FROM scores s WHERE s.posting_id = p.id AND s.source IN ('v2', 'v2-rule') ORDER BY s.id DESC LIMIT 1) AS v2_score,
      EXISTS (SELECT 1 FROM artifacts a WHERE a.posting_id = p.id AND a.kind = 'resume_tweaks' AND a.source = 'v2') AS has_tweaks,
      EXISTS (SELECT 1 FROM artifacts a WHERE a.posting_id = p.id AND a.kind = 'cover_letter' AND a.source = 'v2') AS has_letter,
      (SELECT a.id FROM artifacts a WHERE a.posting_id = p.id AND a.kind = 'cover_letter' AND a.source = 'v2'
         AND a.doc_id IS NULL ORDER BY a.id DESC LIMIT 1) AS letter_missing_doc
    FROM postings p`;
  if (ids?.length) return db.prepare(`${base} WHERE p.id IN (${ids.map(() => '?').join(', ')}) ORDER BY p.id`).all(...ids);
  return db
    .prepare(`SELECT * FROM (${base} WHERE p.stage = 'pipeline' AND p.status IN ('new', 'applied'))
      WHERE v2_score >= ? AND (has_tweaks = 0 OR has_letter = 0 OR letter_missing_doc IS NOT NULL) ORDER BY id`)
    .all(promoteAt);
}

function promptValues(posting, analysis, config) {
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
export function buildTweaksRequest(posting, analysis, { config, knowledge, prompts }) {
  return { model: HUNT_MODEL, system: knowledge, prompt: fillTemplate(prompts.tweaks.template, promptValues(posting, analysis, config)), label: 'resume-tweaks', ...HUNT_SETTINGS };
}

/** claude.send options for a cover letter body. */
export function buildLetterRequest(posting, analysis, { config, knowledge, prompts }) {
  return { model: HUNT_MODEL, system: knowledge, prompt: fillTemplate(prompts.letter.template, promptValues(posting, analysis, config)), label: 'cover-letter', ...HUNT_SETTINGS };
}

// The cover letter prompt asks for under 350 words; models run over, so it is checked in code.
export const MAX_LETTER_WORDS = 350;

/** Cleans a letter body and returns { body, flags }. */
export function finishLetter(text, config) {
  const body = sanitizeDashes(stripSalutationAndSignoff(text, [config.candidate.name, config.candidate.signoffName]));
  const flags = checkCoverLetter(body, config.coverLetterChecks ?? []);
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > MAX_LETTER_WORDS) flags.push(`${words} words (limit ${MAX_LETTER_WORDS})`);
  return { body, flags };
}

const longDate = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const isoLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Generates what each selected posting is missing: resume tweaks, a cover letter, or just the
 * letter's Google Doc (when an earlier save failed).
 * @param {object} ctx
 * @param {{db, tx}} ctx.store
 * @param {object} ctx.config
 * @param {{send}} ctx.claude
 * @param {string} ctx.knowledge
 * @param {object|null} ctx.drive       from createDriveClient(), or null to skip Docs
 * @param {object} [ctx.run]
 * @param {object} [ctx.options]        { ids, regenerate, promoteAt, maxConsecutiveFailures = 3 }
 */
export async function generateForPostings({ store, config, claude, knowledge, drive, run, now = new Date(), options = {} }) {
  const { ids, regenerate = false, promoteAt = PROMOTE_AT, maxConsecutiveFailures = 3 } = options;
  const { db } = store;
  const prompts = loadHuntPrompts(db);
  const postings = selectForHunt(db, { ids, promoteAt });

  const insertArtifact = db.prepare(`INSERT INTO artifacts (posting_id, kind, content, flags_json, source, model, prompt_version, run_id, created_at)
    VALUES (?, ?, ?, ?, 'v2', ?, ?, ?, ?)`);
  const setDoc = db.prepare('UPDATE artifacts SET doc_id = ?, doc_url = ?, doc_name = ? WHERE id = ?');
  const letterById = db.prepare('SELECT content FROM artifacts WHERE id = ?');

  const summary = { selected: postings.length, tweaks: 0, letters: 0, docs: 0, docFailures: [], flagged: [], skipped: [], failures: [], aborted: false };
  let consecutive = 0;
  let folderId = null;

  const saveDoc = async (posting, artifactId, body) => {
    if (!drive) return;
    try {
      folderId ??= await ensureLetterFolder(drive, db);
      const name = letterDocName(posting.company, posting.title, isoLocalDate(now));
      const html = letterHtml({ candidate: config.candidate, company: posting.company, title: posting.title, date: longDate(now), body });
      const doc = await drive.createDocFromHtml({ name, html, folderId });
      setDoc.run(doc.id, doc.url, name, artifactId);
      summary.docs += 1;
      run?.log?.('info', `#${posting.id}: letter saved as a Google Doc`);
    } catch (err) {
      summary.docFailures.push({ id: posting.id, error: `${err.name}: ${err.message}` });
    }
  };

  const call = async (request) => {
    const res = await claude.send({ ...request, trace: run });
    consecutive = 0;
    return res.text;
  };

  const log = (msg) => run?.log?.('info', msg);
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
    try {
      if (!p.has_tweaks || regenerate) {
        log(`${tag}: writing resume tweaks`);
        const tweaks = sanitizeDashes(await call(buildTweaksRequest(p, analysis, { config, knowledge, prompts })));
        insertArtifact.run(p.id, 'resume_tweaks', tweaks, null, HUNT_MODEL, prompts.tweaks.version, run?.id ?? null, nowIso);
        summary.tweaks += 1;
      }
      if (p.letter_missing_doc && !regenerate) {
        log(`${tag}: saving the earlier letter as a Google Doc`);
        await saveDoc(p, p.letter_missing_doc, letterById.get(p.letter_missing_doc).content);
      } else if (!p.has_letter || regenerate) {
        log(`${tag}: writing cover letter`);
        const { body, flags } = finishLetter(await call(buildLetterRequest(p, analysis, { config, knowledge, prompts })), config);
        const artifactId = Number(
          insertArtifact.run(p.id, 'cover_letter', body, flags.length ? JSON.stringify(flags) : null, HUNT_MODEL, prompts.letter.version, run?.id ?? null, nowIso).lastInsertRowid,
        );
        summary.letters += 1;
        if (flags.length) summary.flagged.push({ id: p.id, flags });
        await saveDoc(p, artifactId, body);
      }
    } catch (err) {
      consecutive += 1;
      summary.failures.push({ id: p.id, error: `${err.name}: ${err.message}` });
      run?.log?.('warn', `Hunt generation failed for posting ${p.id}: ${err.name}`);
      if (consecutive >= maxConsecutiveFailures) summary.aborted = true;
    }
  }
  return summary;
}

/** Rough cost estimate: two Sonnet calls per posting that needs both. */
export function estimateHuntCost(postings, knowledgeChars) {
  let usd = 0;
  for (const p of postings) {
    const calls = (p.has_tweaks ? 0 : 1) + (p.has_letter ? 0 : 1);
    const inputTokens = (knowledgeChars + 2500 + Math.min((p.jd_text || p.fetched_text || '').length, CONTENT_CHARS)) / 4;
    usd += calls * ((inputTokens * 2 + 2000 * 10) / 1_000_000); // ~2000 output tokens including thinking
  }
  return usd;
}
