// One-time import of the v1 Google Sheets exports into the Job-Agent database.
// Pure logic over parsed CSV rows; scripts/import-v1.js handles files and output.
import { normalizeUrl, companyTitleKey } from '../tools/urls.js';
import { parseSheetDate, parsePostedDate } from '../tools/dates.js';

const STATUS_MAP = {
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
export function mapStatus(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  if (key in STATUS_MAP) return { status: STATUS_MAP[key], known: true };
  if (key.includes('interview')) return { status: 'interviewing', known: true };
  if (key.includes('pass')) return { status: 'passed', known: true };
  return { status: 'new', known: false };
}

/** v1's fit-score formats: "FIT SCORE: 8", "8 of 10", "8/10". Returns the number found, or null. */
export function extractFitScore(text) {
  const s = String(text ?? '');
  const m = /FIT\s*SCORE[:\s]*(\d+)/i.exec(s) ?? /(\d+)\s*of\s*10/i.exec(s) ?? /(\d+)\/10/.exec(s);
  return m ? Number(m[1]) : null;
}

/** Splits a v1 Cover Letter cell ("Row12_Acme_CoverLetter | saved ... | REVIEW: a; b"). */
export function parseCoverLetterCell(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return null;
  const docName = s.split(' | ')[0].trim();
  const review = /REVIEW:\s*(.+)$/.exec(s)?.[1];
  const flags = review ? review.split(';').map((f) => f.trim()).filter(Boolean) : [];
  return { docName, flags };
}

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s.length ? s : null;
};

/**
 * Imports v1 rows into an empty database inside one transaction.
 * @param {{ db, tx }} store             from openJobStore()
 * @param {object} input
 * @param {object[]} input.discovered    rows of the Discovered Jobs sheet
 * @param {Array<{name: string, current: boolean, rows: object[]}>} input.hunt
 *        hunt sheet files in import order; later files update earlier ones, so the current Jobs tab goes last
 * @param {object} [options]
 * @param {string} [options.now]         ISO timestamp for created_at/updated_at
 * @param {string} [options.today]       ISO date used when a row has no readable discovery date
 * @param {number|null} [options.runId]  runs.id for provenance
 * @returns {object} counts for the summary
 */
export function importV1(store, { discovered = [], hunt = [] }, { now = new Date().toISOString(), today = now.slice(0, 10), runId = null } = {}) {
  const { db } = store;
  if (db.prepare('SELECT COUNT(*) FROM postings').pluck().get() > 0) {
    throw new Error('The database already has postings; the v1 import only runs into an empty database (use --reset).');
  }
  const counts = {
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

  const byUrl = db.prepare('SELECT * FROM postings WHERE url_key = ?');
  const byCompanyTitle = db.prepare('SELECT * FROM postings WHERE company_title_key = ? ORDER BY id LIMIT 1');
  const insertPosting = db.prepare(`INSERT INTO postings
    (url, url_key, company, title, company_title_key, source, location, salary, job_type, posted_on, posted_raw,
     discovered_on, stage, status, applied_on, notes, jd_text, created_at, updated_at)
    VALUES (@url, @url_key, @company, @title, @company_title_key, @source, @location, @salary, @job_type, @posted_on,
     @posted_raw, @discovered_on, @stage, @status, @applied_on, @notes, @jd_text, @now, @now)`);
  const updatePosting = db.prepare(`UPDATE postings SET stage = @stage, status = @status,
      applied_on = COALESCE(@applied_on, applied_on), notes = COALESCE(@notes, notes), jd_text = COALESCE(@jd_text, jd_text),
      updated_at = @now WHERE id = @id`);
  const insertHistory = db.prepare(`INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at)
    VALUES (?, ?, ?, 'import', ?)`);
  const scoreExists = db.prepare('SELECT 1 FROM scores WHERE posting_id = ? AND source = ? AND score = ?');
  const insertScore = db.prepare(`INSERT INTO scores (posting_id, score, reason, source, run_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const artifactExists = db.prepare(`SELECT 1 FROM artifacts WHERE posting_id = ? AND kind = ? AND source = 'v1'
    AND IFNULL(content, '') = IFNULL(?, '') AND IFNULL(doc_name, '') = IFNULL(?, '')`);
  const insertArtifact = db.prepare(`INSERT INTO artifacts (posting_id, kind, content, doc_name, flags_json, source, run_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'v1', ?, ?)`);

  const noteUnknown = (raw) => {
    const k = String(raw).trim();
    counts.unknownStatuses[k] = (counts.unknownStatuses[k] ?? 0) + 1;
  };
  const addScore = (postingId, score, reason, source) => {
    if (score == null) return;
    if (score < 1 || score > 10) {
      counts.outOfRangeScores += 1;
      return;
    }
    if (scoreExists.get(postingId, source, score)) return;
    insertScore.run(postingId, score, reason, source, runId, now);
    counts.scores[source] += 1;
  };
  const addArtifact = (postingId, kind, content, docName = null, flags = null) => {
    if (!content && !docName) return;
    if (artifactExists.get(postingId, kind, content, docName)) return;
    insertArtifact.run(postingId, kind, content, docName, flags?.length ? JSON.stringify(flags) : null, runId, now);
    counts.artifacts[kind] += 1;
  };
  const create = (fields) => {
    const id = Number(insertPosting.run({ ...fields, now }).lastInsertRowid);
    insertHistory.run(id, null, fields.status, now);
    counts.postingsCreated += 1;
    return id;
  };

  store.tx(() => {
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

      let posting = urlKey ? byUrl.get(urlKey) : null;
      let id;
      if (posting) {
        counts.duplicateDiscoveredRows += 1;
        id = posting.id;
      } else {
        id = create({
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
      const isShortReason = quick && !/\n/.test(quick[1].trim());
      addScore(id, extractFitScore(row['Fit Score']), isShortReason ? clean(quick[1]) : null, 'v1-quick');
      if (analysis && !isShortReason) addArtifact(id, 'analysis', analysis);
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

        const posting = (urlKey && byUrl.get(urlKey)) || byCompanyTitle.get(ctKey);
        let id;
        if (posting) {
          id = posting.id;
          // Files arrive archives first and the current Jobs tab last, so the last write is the current state.
          updatePosting.run({ ...fields, id, now });
          if (posting.status !== fields.status) insertHistory.run(id, posting.status, fields.status, now);
        } else {
          id = create({
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
        addScore(id, extractFitScore(analysis), null, 'v1-analysis');
        addArtifact(id, 'analysis', analysis);
        addArtifact(id, 'resume_tweaks', clean(row['Resume Tweaks']));
        const letter = parseCoverLetterCell(row['Cover Letter']);
        if (letter) addArtifact(id, 'cover_letter', null, letter.docName, letter.flags);
      }
    }
  });

  counts.byStageStatus = db
    .prepare('SELECT stage, status, COUNT(*) AS n FROM postings GROUP BY stage, status ORDER BY stage, n DESC')
    .all();
  counts.bySource = db.prepare('SELECT source, COUNT(*) AS n FROM postings GROUP BY source ORDER BY n DESC').all();
  return counts;
}
