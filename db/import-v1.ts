// One-time import of the v1 Google Sheets exports into the Job-Agent database.
// Pure logic over parsed CSV rows; scripts/import-v1.js handles files and output.
import { normalizeUrl, companyTitleKey } from '../tools/urls.ts';
import { parseSheetDate, parsePostedDate, localDay } from '../tools/dates.ts';
import { adoptNotesText } from '../agents/notes.ts';
import type { JobStore } from './index.ts';
import type { PostingsRow } from './types.ts';

/** The import's summary counts; the stage, status, and source totals are added at the end. */
export interface ImportCounts {
  discoveredRows: number;
  huntRows: number;
  postingsCreated: number;
  manualPostings: number;
  duplicateDiscoveredRows: number;
  skippedRows: number;
  outOfRangeScores: number;
  unknownStatuses: Record<string, number>;
  scores: Record<string, number>;
  artifacts: Record<string, number>;
  byStageStatus?: Array<{ stage: string; status: string; n: number }>;
  bySource?: Array<{ source: string | null; n: number }>;
}

/** A row of a v1 sheet export: column heading to cell text. */
export type SheetRow = Record<string, string | undefined>;

const STATUS_MAP: Record<string, string> = {
  '': 'new',
  new: 'new',
  applied: 'applied',
  interviewing: 'interviewing',
  offer: 'offer',
  pass: 'passed',
  'pass/not applying': 'passed',
  closed: 'closed',
  rejected: 'rejected',
};

/** Maps a v1 Status cell to a v2 status; unknown values fall back to 'new' and are reported. */
export function mapStatus(raw: string | null | undefined) {
  const key = String(raw ?? '').trim().toLowerCase();
  if (key in STATUS_MAP) return { status: STATUS_MAP[key] as string, known: true };
  if (key.includes('interview')) return { status: 'interviewing', known: true };
  if (key.includes('pass')) return { status: 'passed', known: true };
  return { status: 'new', known: false };
}

/** v1's fit-score formats: "FIT SCORE: 8", "8 of 10", "8/10". Returns the number found, or null. */
export function extractFitScore(text: string | null | undefined) {
  const s = String(text ?? '');
  const m = /FIT\s*SCORE[:\s]*(\d+)/i.exec(s) ?? /(\d+)\s*of\s*10/i.exec(s) ?? /(\d+)\/10/.exec(s);
  return m ? Number(m[1]) : null;
}

/** Splits a v1 Cover Letter cell ("Row12_Acme_CoverLetter | saved ... | REVIEW: a; b"). */
export function parseCoverLetterCell(cell: string | null | undefined) {
  const s = String(cell ?? '').trim();
  if (!s) return null;
  const docName = (s.split(' | ')[0] as string).trim();
  const review = /REVIEW:\s*(.+)$/.exec(s)?.[1];
  const flags = review ? review.split(';').map((f) => f.trim()).filter(Boolean) : [];
  return { docName, flags };
}

const clean = (v: string | null | undefined) => {
  const s = String(v ?? '').trim();
  return s.length ? s : null;
};

/**
 * Imports v1 rows into an empty database inside one transaction. discovered holds the Discovered Jobs sheet's rows; hunt
 * the hunt sheet files in import order (later files update earlier ones, so the current Jobs tab goes last). now is the
 * ISO timestamp for created_at and updated_at, today the ISO date for a row with no readable discovery date, and runId
 * the runs.id for provenance. Returns counts for the summary. The rows go in through the async engine (db/engine) in
 * one transaction; the notes adoption after it still takes the synchronous db until agents/notes.ts converts.
 */
export async function importV1(
  store: Pick<JobStore, 'db'>,
  { discovered = [], hunt = [] }: { discovered?: SheetRow[]; hunt?: Array<{ name: string; current: boolean; rows: SheetRow[] }> },
  { now = new Date().toISOString(), today = localDay(new Date(now)), runId = null }: { now?: string; today?: string; runId?: number | null } = {},
) {
  const { db } = store;
  const q = db;
  if (((await q.prepare('SELECT COUNT(*) FROM postings WHERE user_id = @uid').pluck().get()) as number) > 0) {
    throw new Error('The database already has postings; the v1 import only runs into an empty database (use --reset).');
  }
  const counts: ImportCounts = {
    discoveredRows: discovered.length,
    huntRows: hunt.reduce((n, f) => n + f.rows.length, 0),
    postingsCreated: 0,
    manualPostings: 0,
    duplicateDiscoveredRows: 0,
    skippedRows: 0,
    outOfRangeScores: 0,
    unknownStatuses: {},
    scores: { 'v1-quick': 0, 'v1-analysis': 0 },
    artifacts: { analysis: 0, resume_tweaks: 0, cover_letter: 0 },
  };

  const byUrl = q.prepare('SELECT * FROM postings WHERE url_key = ? AND user_id = @uid');
  const byCompanyTitle = q.prepare('SELECT * FROM postings WHERE company_title_key = ? AND user_id = @uid ORDER BY id LIMIT 1');
  const insertPosting = q.prepare(`INSERT INTO postings
    (user_id, url, url_key, company, title, company_title_key, source, location, salary, job_type, posted_on, posted_raw,
     discovered_on, stage, status, applied_on, notes, jd_text, created_at, updated_at)
    VALUES (@uid, @url, @url_key, @company, @title, @company_title_key, @source, @location, @salary, @job_type, @posted_on,
     @posted_raw, @discovered_on, @stage, @status, @applied_on, @notes, @jd_text, @now, @now)`);
  const updatePosting = q.prepare(`UPDATE postings SET stage = @stage, status = @status,
      applied_on = COALESCE(@applied_on, applied_on), notes = COALESCE(@notes, notes), jd_text = COALESCE(@jd_text, jd_text),
      updated_at = @now WHERE id = @id AND user_id = @uid`);
  const insertHistory = q.prepare(`INSERT INTO status_history (user_id, posting_id, from_status, to_status, changed_by, changed_at)
    VALUES (@uid, ?, ?, ?, 'import', ?)`);
  const scoreExists = q.prepare('SELECT 1 FROM scores WHERE posting_id = ? AND user_id = @uid AND source = ? AND score = ?');
  const insertScore = q.prepare(`INSERT INTO scores (user_id, posting_id, score, reason, source, run_id, created_at)
    VALUES (@uid, ?, ?, ?, ?, ?, ?)`);
  const artifactExists = q.prepare(`SELECT 1 FROM artifacts WHERE posting_id = ? AND user_id = @uid AND kind = ? AND source = 'v1'
    AND IFNULL(content, '') = IFNULL(?, '') AND IFNULL(doc_name, '') = IFNULL(?, '')`);
  const insertArtifact = q.prepare(`INSERT INTO artifacts (user_id, posting_id, kind, content, doc_name, flags_json, source, run_id, created_at)
    VALUES (@uid, ?, ?, ?, ?, ?, 'v1', ?, ?)`);

  const noteUnknown = (raw: string | null | undefined) => {
    const k = String(raw).trim();
    counts.unknownStatuses[k] = (counts.unknownStatuses[k] ?? 0) + 1;
  };
  const addScore = async (postingId: number, score: number | null, reason: string | null, source: string) => {
    if (score == null) return;
    if (score < 1 || score > 10) {
      counts.outOfRangeScores += 1;
      return;
    }
    if (await scoreExists.get(postingId, source, score)) return;
    await insertScore.run(postingId, score, reason, source, runId, now);
    counts.scores[source] = (counts.scores[source] as number) + 1;
  };
  const addArtifact = async (postingId: number, kind: string, content: string | null, docName: string | null = null, flags: string[] | null = null) => {
    if (!content && !docName) return;
    if (await artifactExists.get(postingId, kind, content, docName)) return;
    await insertArtifact.run(postingId, kind, content, docName, flags?.length ? JSON.stringify(flags) : null, runId, now);
    counts.artifacts[kind] = (counts.artifacts[kind] as number) + 1;
  };
  const create = async (fields: Record<string, unknown> & { status: string }) => {
    const id = Number((await insertPosting.run({ ...fields, now })).id);
    await insertHistory.run(id, null, fields.status, now);
    counts.postingsCreated += 1;
    return id;
  };

  await q.tx(async () => {
    // 1. Discovered sheet
    for (const row of discovered) {
      const company = clean(row['Company']);
      const title = clean(row['Role Title']);
      if (!company || !title) {
        counts.skippedRows += 1;
        continue;
      }
      const url = clean(row['Job URL']);
      const urlKey = normalizeUrl(url);
      const discoveredOn = parseSheetDate(row['Date Discovered']) ?? today;
      const statusCell = clean(row['Status']) ?? '';
      const promoted = statusCell.toLowerCase() === 'added to pipeline';
      if (!promoted && mapStatus(statusCell).known === false) noteUnknown(statusCell);

      const posting = urlKey ? ((await byUrl.get(urlKey)) as PostingsRow | undefined) : null;
      let id: number;
      if (posting) {
        counts.duplicateDiscoveredRows += 1;
        id = posting.id;
      } else {
        id = await create({
          url,
          url_key: urlKey,
          company,
          title,
          company_title_key: companyTitleKey(company, title),
          source: clean(row['Source']),
          location: clean(row['Location']),
          salary: clean(row['Salary']),
          job_type: clean(row['Job Type']),
          posted_on: parsePostedDate(row['Job Posted'], row['Date Discovered']),
          posted_raw: clean(row['Job Posted']),
          discovered_on: discoveredOn,
          // Promoted jobs start archived: only the current Jobs tab decides what is still in the pipeline,
          // and a promoted job missing from every hunt export was removed from the hunt sheet in v1.
          stage: promoted ? 'archived' : 'discovered',
          status: 'new',
          applied_on: null,
          notes: clean(row['Notes']),
          jd_text: null,
        });
      }

      const analysis = clean(row['Analysis']);
      const quick = analysis ? /^\s*\d+\s*of\s*10\.?\s*([\s\S]*)$/i.exec(analysis) : null;
      const isShortReason = quick && !/\n/.test((quick[1] as string).trim());
      await addScore(id, extractFitScore(row['Fit Score']), isShortReason ? clean(quick[1]) : null, 'v1-quick');
      if (analysis && !isShortReason) await addArtifact(id, 'analysis', analysis);
    }

    // 2. Hunt sheets, archives first and the current Jobs tab last
    for (const file of hunt) {
      for (const row of file.rows) {
        const company = clean(row['Company']);
        if (!company) {
          counts.skippedRows += 1;
          continue;
        }
        const title = clean(row['Role Title']) ?? '(no title)';
        const url = clean(row['Job URL']);
        const urlKey = normalizeUrl(url);
        const ctKey = companyTitleKey(company, title);
        const mapped = mapStatus(row['Status']);
        if (!mapped.known) noteUnknown(row['Status']);
        const jd = clean(row['Job Description if URL does not work']);
        const fields = {
          stage: file.current ? 'pipeline' : 'archived',
          status: mapped.status,
          applied_on: parseSheetDate(row['Date Applied']),
          notes: clean(row['Notes/Comments']),
          jd_text: jd && jd.length > 30 ? jd : null,
        };

        const posting = ((urlKey && (await byUrl.get(urlKey))) || (await byCompanyTitle.get(ctKey))) as PostingsRow | undefined;
        let id: number;
        if (posting) {
          id = posting.id;
          // Files arrive archives first and the current Jobs tab last, so the last write is the current state.
          await updatePosting.run({ ...fields, id, now });
          if (posting.status !== fields.status) await insertHistory.run(id, posting.status, fields.status, now);
        } else {
          id = await create({
            url,
            url_key: urlKey,
            company,
            title,
            company_title_key: ctKey,
            source: 'v1-manual',
            location: null,
            salary: null,
            job_type: null,
            posted_on: null,
            posted_raw: null,
            discovered_on: parseSheetDate(row['Discovered']) ?? today,
            ...fields,
          });
          counts.manualPostings += 1;
        }

        const analysis = clean(row['Claude Analysis']);
        await addScore(id, extractFitScore(analysis), null, 'v1-analysis');
        await addArtifact(id, 'analysis', analysis);
        await addArtifact(id, 'resume_tweaks', clean(row['Resume Tweaks']));
        const letter = parseCoverLetterCell(row['Cover Letter']);
        if (letter) await addArtifact(id, 'cover_letter', null, letter.docName, letter.flags);
      }
    }
  });

  // Imported notes text becomes one 'earlier' note per job (its date was never recorded in v1).
  await adoptNotesText(db, { source: 'earlier', now: new Date(now) });

  counts.byStageStatus = (await q
    .prepare('SELECT stage, status, COUNT(*) AS n FROM postings WHERE user_id = @uid GROUP BY stage, status ORDER BY stage, n DESC')
    .all()) as ImportCounts['byStageStatus'];
  counts.bySource = (await q.prepare('SELECT source, COUNT(*) AS n FROM postings WHERE user_id = @uid GROUP BY source ORDER BY n DESC').all()) as ImportCounts['bySource'];
  return counts;
}
