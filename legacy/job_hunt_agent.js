// ============================================================
// CONFIGURATION
// Everything specific to the candidate lives in Project Settings > Script Properties.
// Required: ANTHROPIC_API_KEY, EMAIL_ADDRESS, COVER_LETTER_FOLDER_ID,
//   YOUR_KNOWLEDGE_DOC_ID, JOB_HUNT_SHEET_ID,
//   CONTACT_NAME, CONTACT_LINE, CONTACT_LINKEDIN,
//   ANALYSIS_PROMPT, COVER_LETTER_PROMPT, RESUME_TWEAKS_PROMPT
// Optional: SIGNOFF_NAME (defaults to CONTACT_NAME),
//   COVER_LETTER_CHECKS (JSON list of rule checks; see checkCoverLetterRules)
// ============================================================
function getSetting_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error('Missing Script Property "' + name + '". Add it in Project Settings > Script Properties.');
  return value.trim();
}

var ANTHROPIC_API_KEY = getSetting_('ANTHROPIC_API_KEY');
var EMAIL_ADDRESS = getSetting_('EMAIL_ADDRESS');
var COVER_LETTER_FOLDER_ID = getSetting_('COVER_LETTER_FOLDER_ID');
var YOUR_KNOWLEDGE_DOC_ID = getSetting_('YOUR_KNOWLEDGE_DOC_ID');
var JOB_HUNT_SHEET_ID = getSetting_('JOB_HUNT_SHEET_ID');

// Contact block used on every saved cover letter
var CONTACT_NAME = getSetting_('CONTACT_NAME');
var CONTACT_LINE = getSetting_('CONTACT_LINE');
var CONTACT_LINKEDIN = getSetting_('CONTACT_LINKEDIN');
var SIGNOFF_NAME = (PropertiesService.getScriptProperties().getProperty('SIGNOFF_NAME') || CONTACT_NAME).trim();

var SHEET_NAME = 'Jobs';

// Models. Analysis and tweaks run fine on Haiku. Cover letters are the
// highest stakes output, so you can point COVER_LETTER_MODEL at a
// stronger model later without touching anything else.
var CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
var COVER_LETTER_MODEL = 'claude-haiku-4-5-20251001';

var MIN_SCORE_FOR_COVER_LETTER = 7;
var MAX_RUN_TIME_MS = 5 * 60 * 1000;

// ============================================================
// COLUMN INDICES (1-based)
// Discovered | Date Applied | Company | Role Title | Job URL |
// Job Description if URL does not work | Notes/Comments |
// Claude Analysis | Resume Tweaks | Cover Letter | Status
// ============================================================
var COL_DISCOVERED = 1;
var COL_DATE_APPLIED = 2;
var COL_COMPANY = 3;
var COL_ROLE = 4;
var COL_URL = 5;
var COL_JD = 6;
var COL_NOTES = 7;
var COL_ANALYSIS = 8;
var COL_RESUME_TWEAKS = 9;
var COL_COVER_LETTER = 10;
var COL_STATUS = 11;
var TOTAL_COLS = 11;

// ============================================================
// ARCHIVE OLD JOBS
// Moves rows from the Jobs tab to the Archive tab when:
//   1. Status is Closed, Pass, or Rejected (immediately, any age), or
//   2. Discovered date is older than ARCHIVE_AFTER_DAYS, unless the
//      status shows an active conversation (Interviewing, Offer).
// ============================================================
var ARCHIVE_TAB_NAME = 'Archive';
var ARCHIVE_AFTER_DAYS = 30;
var ARCHIVE_KEEP_STATUSES = ['interview', 'offer'];
var ARCHIVE_NOW_STATUSES = ['closed', 'pass', 'rejected'];

// Run this first: logs what WOULD move, changes nothing
function previewArchive() { runArchive_(false); }

// Does the actual move (also what the weekly trigger calls)
function archiveOldJobs() { runArchive_(true); }

function runArchive_(commit) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('Another archive run is in progress. Skipped.');
    return;
  }
  try {
    var sheet = getJobsSheet();
    var ss = sheet.getParent();
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2) { Logger.log('No rows on the Jobs tab.'); return; }

    var cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - ARCHIVE_AFTER_DAYS);

    var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    var toArchive = [];
    var rowNums = [];
    var kept = 0;
    var badDates = 0;

    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var company = String(row[COL_COMPANY - 1] || '').trim();
      if (!company) continue;

      var statusRaw = String(row[COL_STATUS - 1] || '').trim();
      var status = statusRaw.toLowerCase();

      // Closed, Pass, or Rejected: archive immediately, regardless of age
      var archiveNow = ARCHIVE_NOW_STATUSES.some(function(s) { return status.indexOf(s) !== -1; });
      if (archiveNow) {
        toArchive.push(row);
        rowNums.push(i + 2);
        Logger.log((commit ? 'Archiving' : 'Would archive') + ' row ' + (i + 2) + ': ' + company +
                   ' | ' + row[COL_ROLE - 1] + ' (status: ' + statusRaw + ')');
        continue;
      }

      // Everything else: archive only if older than the cutoff
      var discovered = parseSheetDate_(row[COL_DISCOVERED - 1]);
      if (!discovered) {
        badDates++;
        Logger.log('Row ' + (i + 2) + ' (' + company + '): no readable Discovered date, left in place');
        continue;
      }
      if (discovered >= cutoff) continue;

      var keep = ARCHIVE_KEEP_STATUSES.some(function(s) { return status.indexOf(s) !== -1; });
      if (keep) {
        kept++;
        Logger.log('Row ' + (i + 2) + ' (' + company + '): older than cutoff but status is "' + statusRaw + '", kept');
        continue;
      }

      toArchive.push(row);
      rowNums.push(i + 2);
      Logger.log((commit ? 'Archiving' : 'Would archive') + ' row ' + (i + 2) + ': ' + company +
                 ' | ' + row[COL_ROLE - 1] + ' (older than ' + ARCHIVE_AFTER_DAYS + ' days)');
    }

    Logger.log('Summary: ' + toArchive.length + ' to archive, ' + kept + ' kept for active status, ' +
               badDates + ' skipped for unreadable dates. Cutoff: ' + cutoff.toLocaleDateString());

    if (!commit || toArchive.length === 0) return;

    // Write to Archive FIRST, then delete from Jobs, so a failure never loses data
    var archive = ss.getSheetByName(ARCHIVE_TAB_NAME) || ss.insertSheet(ARCHIVE_TAB_NAME);
    if (archive.getMaxColumns() < lastCol) {
      archive.insertColumnsAfter(archive.getMaxColumns(), lastCol - archive.getMaxColumns());
    }
    if (archive.getLastRow() === 0) {
      archive.getRange(1, 1, 1, lastCol).setValues(sheet.getRange(1, 1, 1, lastCol).getValues());
      archive.setFrozenRows(1);
    }
    archive.getRange(archive.getLastRow() + 1, 1, toArchive.length, lastCol).setValues(toArchive);
    SpreadsheetApp.flush();

    // Delete bottom up in contiguous blocks so row numbers stay valid
    var j = rowNums.length - 1;
    while (j >= 0) {
      var end = rowNums[j];
      var start = end;
      while (j > 0 && rowNums[j - 1] === start - 1) { j--; start--; }
      sheet.deleteRows(start, end - start + 1);
      j--;
    }

    Logger.log('Archive complete. Moved ' + toArchive.length + ' rows to ' + ARCHIVE_TAB_NAME + '.');
  } finally {
    lock.releaseLock();
  }
}

// Handles both real date cells and text dates like "9/24/2026"
function parseSheetDate_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  var s = String(value || '').trim();
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Run once to archive automatically every Sunday at 7am
function createWeeklyArchiveTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'archiveOldJobs') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('archiveOldJobs').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(7).create();
  Logger.log('Weekly archive trigger created (Sundays, 7am).');
}

// ============================================================
// SHEET ACCESS
// Opens the pipeline sheet by ID so the script works no matter which
// spreadsheet (if any) it is attached to.
// ============================================================
function getJobsSheet() {
  var ss = SpreadsheetApp.openById(JOB_HUNT_SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    var tabs = ss.getSheets().map(function(sh) { return '"' + sh.getName() + '"'; }).join(', ');
    throw new Error('No tab named "' + SHEET_NAME + '" in ' + ss.getName() + '. Tabs found: ' + tabs);
  }
  return sheet;
}

// ============================================================
// CANDIDATE KNOWLEDGE (Google Doc is the single source of truth)
// ============================================================
function getCandidateKnowledge() {
  return DocumentApp.openById(YOUR_KNOWLEDGE_DOC_ID).getBody().getText();
}

// Loads the doc and validates it. Returns '' if unusable so callers can abort.
function loadKnowledgeOrAbort(caller) {
  try {
    var k = getCandidateKnowledge();
    if (!k || k.length < 500) {
      Logger.log(caller + ': Candidate Knowledge doc is empty or too short. Aborted.');
      return '';
    }
    return k;
  } catch (e) {
    Logger.log(caller + ': Could not load Candidate Knowledge doc: ' + e.message + '. Aborted.');
    return '';
  }
}

// Run this manually once to confirm the doc loads
function testCandidateKnowledge() {
  var text = getCandidateKnowledge();
  Logger.log('Loaded ' + text.length + ' characters. First line: ' + text.split('\n')[0]);
}

// Logs every Script Property name and value length (never the values)
function listScriptProperties() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var names = Object.keys(props).sort();
  Logger.log('Project: ' + ScriptApp.getScriptId());
  Logger.log(names.length + ' properties stored:');
  names.forEach(function(n) {
    Logger.log('  ' + n + ' (' + props[n].length + ' chars)');
  });
  var required = ['ANTHROPIC_API_KEY', 'EMAIL_ADDRESS', 'COVER_LETTER_FOLDER_ID', 'YOUR_KNOWLEDGE_DOC_ID',
                  'JOB_HUNT_SHEET_ID', 'CONTACT_NAME', 'CONTACT_LINE', 'CONTACT_LINKEDIN',
                  'ANALYSIS_PROMPT', 'COVER_LETTER_PROMPT', 'RESUME_TWEAKS_PROMPT'];
  var missing = required.filter(function(n) { return !props[n]; });
  Logger.log(missing.length ? 'MISSING: ' + missing.join(', ') : 'All 11 required properties present.');
}

// ============================================================
// ANALYZE UNPROCESSED JOBS
// ============================================================
function analyzeUnprocessedJobs() {
  var sheet = getJobsSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var knowledge = loadKnowledgeOrAbort('analyzeUnprocessedJobs');
  if (!knowledge) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
  var newlyAnalyzed = [];
  var startTime = new Date().getTime();

  for (var i = 0; i < data.length; i++) {
    if (new Date().getTime() - startTime > MAX_RUN_TIME_MS) {
      Logger.log('Time limit approaching at row ' + (i + 2) + '. Run analyzeUnprocessedJobs again to continue.');
      break;
    }

    var row = data[i];
    var company = String(row[COL_COMPANY - 1] || '').trim();
    var roleTitle = String(row[COL_ROLE - 1] || '').trim();
    var jobUrl = String(row[COL_URL - 1] || '').trim();
    var jobDesc = String(row[COL_JD - 1] || '').trim();
    var notes = String(row[COL_NOTES - 1] || '').trim();
    var analysis = String(row[COL_ANALYSIS - 1] || '').trim();
    var status = String(row[COL_STATUS - 1] || '').toLowerCase().trim();

    if (!company) continue;
    if (analysis.length > 0) continue;
    if (status.indexOf('rejected') !== -1) continue;

    var hasUrl = isUsableUrl(jobUrl);
    var hasJD = jobDesc.length > 30;
    var hasNotes = notes.length > 30;

    if (!hasUrl && !hasJD && !hasNotes) {
      Logger.log('Skipping ' + company + ': no content to analyze');
      continue;
    }

    Logger.log('Analyzing: ' + company + ' | ' + roleTitle);

    var fetchedContent = hasUrl ? fetchJobContent(jobUrl, company) : '';
    var effectiveContent = buildEffectiveContent(fetchedContent, jobDesc, notes);

    var prompt = buildAnalysisPrompt(company, roleTitle, jobUrl, effectiveContent);
    var result = callClaudeWithKnowledge(prompt, 800, knowledge, CLAUDE_MODEL);

    if (result) {
      result = sanitizeDashes(result);
      sheet.getRange(i + 2, COL_ANALYSIS).setValue(result);
      newlyAnalyzed.push({ company: company, roleTitle: roleTitle, analysis: result });
      Logger.log('Analysis saved for ' + company);
    }
    Utilities.sleep(2000);
  }

  // Hand today's analyses to sendDailySummaryEmail (separate trigger).
  // CacheService keeps this temporary data out of Script Properties,
  // where large values block saving settings in the UI.
  var cache = CacheService.getScriptCache();
  var cacheKey = 'analyzed_' + new Date().toLocaleDateString();
  var existing = [];
  try { existing = JSON.parse(cache.get(cacheKey) || '[]'); } catch (e) {}
  cache.put(cacheKey, JSON.stringify(existing.concat(newlyAnalyzed)), 21600); // 6 hours

  return newlyAnalyzed;
}

// ============================================================
// COVER LETTERS AND RESUME TWEAKS (7+ fit score only)
// ============================================================
function generateCoverLettersAndTweaks() {
  var sheet = getJobsSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var knowledge = loadKnowledgeOrAbort('generateCoverLettersAndTweaks');
  if (!knowledge) return;

  var data = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
  var sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  var startTime = new Date().getTime();

  for (var i = 0; i < data.length; i++) {
    if (new Date().getTime() - startTime > MAX_RUN_TIME_MS) {
      Logger.log('Time limit approaching at row ' + (i + 2) + '. Run generateCoverLettersAndTweaks again to continue.');
      break;
    }

    var row = data[i];
    var company = String(row[COL_COMPANY - 1] || '').trim();
    var roleTitle = String(row[COL_ROLE - 1] || '').trim();
    var jobUrl = String(row[COL_URL - 1] || '').trim();
    var jobDesc = String(row[COL_JD - 1] || '').trim();
    var notes = String(row[COL_NOTES - 1] || '').trim();
    var analysis = String(row[COL_ANALYSIS - 1] || '').trim();
    var resumeTweaks = String(row[COL_RESUME_TWEAKS - 1] || '').trim();
    var coverLetter = String(row[COL_COVER_LETTER - 1] || '').trim();
    var status = String(row[COL_STATUS - 1] || '').toLowerCase().trim();

    // Only generate for jobs discovered in the last 7 days
    var discoveredDate = row[COL_DISCOVERED - 1];
    if (discoveredDate) {
      var parsedDate = new Date(discoveredDate);
      if (!isNaN(parsedDate) && parsedDate < sevenDaysAgo) {
        Logger.log('Skipping CL/tweaks for ' + company + ': discovered more than 7 days ago');
        continue;
      }
    }

    if (!company || !analysis || status.indexOf('rejected') !== -1 || status.indexOf('pass') !== -1) continue;
    if (resumeTweaks.length > 0 && coverLetter.length > 0) continue;

    var fitScore = extractFitScore(analysis);
    if (fitScore < MIN_SCORE_FOR_COVER_LETTER) {
      Logger.log('Skipping CL/tweaks for ' + company + ' (score: ' + fitScore + ')');
      continue;
    }

    Logger.log('Generating cover letter + tweaks for ' + company + ' (score: ' + fitScore + ')');

    var isExec = isExecutiveRole(roleTitle);
    var roleType = isExec ? 'executive (CTO, VP, Director)' : 'engineering manager or SDM';

    // Use the actual posting, not just the notes column. Promoted jobs
    // usually have an empty Job Description column.
    var fetchedContent = isUsableUrl(jobUrl) ? fetchJobContent(jobUrl, company) : '';
    var jobContent = fetchedContent.length > 100 ? fetchedContent : (jobDesc.length > 30 ? jobDesc : '');

    if (resumeTweaks.length === 0) {
      var rtPrompt = buildResumeTweaksPrompt(company, roleTitle, jobContent, notes, analysis, roleType);
      var tweaks = callClaudeWithKnowledge(rtPrompt, 1000, knowledge, CLAUDE_MODEL);
      if (tweaks) {
        sheet.getRange(i + 2, COL_RESUME_TWEAKS).setValue(sanitizeDashes(tweaks));
        Logger.log('Resume tweaks saved for ' + company);
      }
      Utilities.sleep(2000);
    }

    if (coverLetter.length === 0) {
      var clPrompt = buildCoverLetterPrompt(company, roleTitle, jobContent, notes, analysis, roleType);
      var letter = callClaudeWithKnowledge(clPrompt, 1200, knowledge, COVER_LETTER_MODEL);
      if (letter) {
        letter = sanitizeDashes(stripSalutationAndSignoff(letter));
        var issues = checkCoverLetterRules(letter);
        var fileName = saveCoverLetterDoc(company, roleTitle, letter, i + 2);
        var cellText = fileName + ' | saved to cover letters folder';
        if (issues.length > 0) {
          cellText += ' | REVIEW: ' + issues.join('; ');
          Logger.log('Rule check flagged ' + company + ': ' + issues.join('; '));
        }
        sheet.getRange(i + 2, COL_COVER_LETTER).setValue(cellText);
        Logger.log('Cover letter saved for ' + company);
      }
      Utilities.sleep(2000);
    }
  }
}

// ============================================================
// DETERMINISTIC RULE CHECKS
// Like the location check in the discovery agent: don't trust the
// prompt alone for rules that matter. Fix what can be fixed, flag the rest.
// ============================================================

// Replace em dashes, en dashes, and double hyphens used as dashes.
function sanitizeDashes(text) {
  if (!text) return text;
  return text
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/\s+--\s+/g, ', ')
    .replace(/--/g, ', ')
    .replace(/, ,/g, ',');
}

// Remove any salutation or sign off the model adds; the doc template supplies them.
function stripSalutationAndSignoff(text) {
  var names = [CONTACT_NAME, SIGNOFF_NAME].map(escapeRegex_).join('|');
  var signoff = new RegExp('^\\s*(sincerely|best regards|regards|thank you|' + names + ')', 'i');
  var lines = text.split('\n');
  while (lines.length && (/^\s*$/.test(lines[0]) || /^\s*dear\b/i.test(lines[0]))) lines.shift();
  while (lines.length && (/^\s*$/.test(lines[lines.length - 1]) || signoff.test(lines[lines.length - 1]))) {
    lines.pop();
  }
  return lines.join('\n');
}

function escapeRegex_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Flags violations of Section 6 that sanitizing can't fix.
// Rules come from the optional COVER_LETTER_CHECKS Script Property: a JSON
// list where each rule has a "label" and either
//   "text": one pattern checked against the whole letter, or
//   "sentence": two patterns that flag a sentence only when BOTH match.
// Patterns are case insensitive regular expressions. Example:
// [{"label":"weak closer","text":"\\bi am confident\\b"},
//  {"label":"wrong title at Acme","sentence":["acme","\\bCTO\\b"]}]
function loadCoverLetterChecks_() {
  var raw = PropertiesService.getScriptProperties().getProperty('COVER_LETTER_CHECKS');
  if (!raw || !raw.trim()) return { rules: [], error: null };
  try {
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('must be a JSON list');
    var rules = parsed.map(function(r) {
      return {
        label: String(r.label || 'rule'),
        text: r.text ? new RegExp(r.text, 'i') : null,
        sentence: Array.isArray(r.sentence) && r.sentence.length === 2
          ? [new RegExp(r.sentence[0], 'i'), new RegExp(r.sentence[1], 'i')] : null
      };
    });
    return { rules: rules, error: null };
  } catch (e) {
    return { rules: [], error: 'COVER_LETTER_CHECKS is invalid (' + e.message + '); rule checks not run' };
  }
}

function checkCoverLetterRules(text) {
  var loaded = loadCoverLetterChecks_();
  if (loaded.error) return [loaded.error];
  var issues = [];
  var sentences = text.split(/(?<=[.!?])\s+/);
  loaded.rules.forEach(function(rule) {
    if (rule.text && rule.text.test(text)) issues.push(rule.label);
    if (rule.sentence) {
      for (var s = 0; s < sentences.length; s++) {
        if (rule.sentence[0].test(sentences[s]) && rule.sentence[1].test(sentences[s])) {
          issues.push(rule.label);
          break;
        }
      }
    }
  });
  // de-duplicate
  return issues.filter(function(v, idx, arr) { return arr.indexOf(v) === idx; });
}

// ============================================================
// DAILY EMAIL SUMMARY
// ============================================================
function sendDailySummaryEmail(newlyAnalyzed) {
  // When run from its own trigger, pull today's analyses from the cache
  if (!Array.isArray(newlyAnalyzed)) {
    newlyAnalyzed = [];
    var cached = CacheService.getScriptCache().get('analyzed_' + new Date().toLocaleDateString());
    if (cached) {
      try { newlyAnalyzed = JSON.parse(cached); } catch (e) {}
    }
  }

  var sheet = getJobsSheet();
  var lastRow = sheet.getLastRow();
  var data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues() : [];
  var today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  var counts = { total: 0, interviewing: 0, applied: 0, worth: 0, offer: 0 };
  var activeRows = [];

  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (!r[COL_COMPANY - 1]) continue;
    var st = String(r[COL_STATUS - 1] || '').toLowerCase();
    if (st.indexOf('rejected') !== -1) continue;
    counts.total++;
    if (st.indexOf('interview') !== -1) counts.interviewing++;
    else if (st.indexOf('applied') !== -1) counts.applied++;
    else if (st.indexOf('worth') !== -1) counts.worth++;
    else if (st.indexOf('offer') !== -1) counts.offer++;
    if (r[COL_ANALYSIS - 1]) activeRows.push(r);
  }

  var html = '<div style="max-width:680px;margin:0 auto;font-family:Arial,sans-serif;">';

  html += '<div style="background:#1a5276;padding:24px 28px;border-radius:6px 6px 0 0;">';
  html += '<h1 style="color:#fff;margin:0;font-size:22px;">Job Search Daily Summary</h1>';
  html += '<p style="color:#a9cce3;margin:6px 0 0;font-size:13px;">' + today + '</p>';
  html += '</div>';

  html += '<div style="background:#f4f6f8;padding:20px 28px;border:1px solid #e0e0e0;">';
  html += '<h2 style="color:#1a5276;font-size:16px;margin:0 0 12px;">Pipeline Summary</h2>';
  html += '<table style="width:100%;border-collapse:collapse;"><tr>';
  var stats = [['Active',counts.total,'#1a5276'],['Interviewing',counts.interviewing,'#1a5276'],
               ['Applied',counts.applied,'#1a5276'],['Worth Pursuing',counts.worth,'#1a5276'],['Offer',counts.offer,'#27ae60']];
  for (var s = 0; s < stats.length; s++) {
    html += '<td style="text-align:center;padding:12px;">';
    html += '<div style="font-size:22px;font-weight:bold;color:' + stats[s][2] + ';">' + stats[s][1] + '</div>';
    html += '<div style="font-size:11px;color:#666;">' + stats[s][0] + '</div></td>';
  }
  html += '</tr></table></div>';

  html += '<div style="padding:20px 28px;background:#fff;border:1px solid #e0e0e0;border-top:none;">';
  if (newlyAnalyzed.length > 0) {
    html += '<h2 style="color:#1a5276;font-size:16px;border-bottom:2px solid #1a5276;padding-bottom:6px;">New Analyses Today (' + newlyAnalyzed.length + ')</h2>';
    for (var j = 0; j < newlyAnalyzed.length; j++) {
      var item = newlyAnalyzed[j];
      var sc = extractFitScore(item.analysis);
      var scColor = sc >= 8 ? '#27ae60' : sc >= 6 ? '#e67e22' : '#e74c3c';
      html += '<div style="border:1px solid #e0e0e0;border-radius:4px;margin-bottom:16px;overflow:hidden;">';
      html += '<div style="background:#f4f6f8;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;">';
      html += '<div><strong style="color:#1a5276;">' + item.company + '</strong> <span style="color:#666;font-size:12px;">| ' + item.roleTitle + '</span></div>';
      if (sc > 0) html += '<span style="background:' + scColor + ';color:#fff;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:bold;">' + sc + ' of 10</span>';
      html += '</div>';
      html += '<div style="padding:12px 16px;font-size:13px;line-height:1.6;white-space:pre-wrap;color:#333;">' + item.analysis + '</div>';
      html += '</div>';
    }
  } else {
    html += '<h2 style="color:#1a5276;font-size:16px;border-bottom:2px solid #1a5276;padding-bottom:6px;">New Analyses Today</h2>';
    html += '<p style="color:#888;font-style:italic;">No new analyses today.</p>';
  }
  html += '</div>';

  html += '<div style="padding:20px 28px;background:#fff;border:1px solid #e0e0e0;border-top:none;">';
  html += '<h2 style="color:#1a5276;font-size:16px;border-bottom:2px solid #1a5276;padding-bottom:6px;">Full Active Pipeline</h2>';
  for (var k = 0; k < activeRows.length; k++) {
    var ar = activeRows[k];
    var arSt = String(ar[COL_STATUS - 1] || 'No Status');
    var arSc = ar[COL_ANALYSIS - 1] ? extractFitScore(String(ar[COL_ANALYSIS - 1])) : 0;
    var arScC = arSc >= 8 ? '#27ae60' : arSc >= 6 ? '#e67e22' : '#c0392b';
    var clCell = String(ar[COL_COVER_LETTER - 1] || '').trim();
    var hasCL = clCell.length > 0;
    var clFlag = clCell.indexOf('REVIEW:') !== -1;
    var hasRT = String(ar[COL_RESUME_TWEAKS - 1] || '').trim().length > 0;
    html += '<div style="padding:10px 0;border-bottom:1px solid #f0f0f0;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
    html += '<div><strong>' + ar[COL_COMPANY - 1] + '</strong> <span style="color:#666;font-size:12px;">| ' + ar[COL_ROLE - 1] + '</span>';
    if (hasCL && !clFlag) html += ' <span style="color:#27ae60;font-size:11px;">[Cover letter ready]</span>';
    if (clFlag) html += ' <span style="color:#c0392b;font-size:11px;">[Cover letter needs review]</span>';
    if (hasRT) html += ' <span style="color:#2980b9;font-size:11px;">[Resume tweaks ready]</span>';
    html += '</div>';
    html += '<div>';
    if (arSc > 0) html += '<span style="color:' + arScC + ';font-weight:bold;font-size:13px;margin-right:8px;">' + arSc + ' of 10</span>';
    html += '<span style="background:#e8f4fd;color:#1a5276;padding:2px 8px;border-radius:10px;font-size:11px;">' + arSt + '</span>';
    html += '</div></div></div>';
  }
  html += '</div>';

  html += '<div style="padding:12px 28px;background:#f4f6f8;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 6px 6px;">';
  html += '<p style="font-size:11px;color:#999;margin:0;text-align:center;">Job Search Agent &middot; Cover letters saved to Google Drive &middot; Powered by Claude AI</p>';
  html += '</div></div>';

  MailApp.sendEmail({ to: EMAIL_ADDRESS, subject: 'Job Search Daily Summary | ' + today, htmlBody: html });
  Logger.log('Daily summary email sent.');
}

// ============================================================
// SAVE COVER LETTER AS GOOGLE DOC
// ============================================================
function saveCoverLetterDoc(company, roleTitle, letterText, rowNum) {
  try {
    var folder = DriveApp.getFolderById(COVER_LETTER_FOLDER_ID);
    var fileName = 'Row' + rowNum + '_' + company.replace(/[^a-zA-Z0-9]/g, '_') + '_CoverLetter';
    var doc = DocumentApp.create(fileName);
    var body = doc.getBody();
    body.clear();

    var header = body.appendParagraph(CONTACT_NAME);
    header.setHeading(DocumentApp.ParagraphHeading.HEADING1);
    body.appendParagraph(CONTACT_LINE).setItalic(true);
    body.appendParagraph(CONTACT_LINKEDIN).setItalic(true);
    body.appendParagraph('').setItalic(false);
    body.appendParagraph(new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }));
    body.appendParagraph('Re: ' + roleTitle + ' at ' + company).setBold(true);
    body.appendParagraph('').setBold(false);
    body.appendParagraph('Dear ' + company + ' Hiring Team,');
    body.appendParagraph('');

    var lines = letterText.split('\n');
    for (var i = 0; i < lines.length; i++) { body.appendParagraph(lines[i]); }

    body.appendParagraph('');
    body.appendParagraph('Sincerely,');
    body.appendParagraph(SIGNOFF_NAME);

    doc.saveAndClose();
    var file = DriveApp.getFileById(doc.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
    Logger.log('Saved cover letter: ' + fileName);
    return fileName;
  } catch(e) {
    Logger.log('Error saving cover letter: ' + e.message);
    return 'Error saving, check logs';
  }
}

// ============================================================
// PROMPT BUILDERS
// Prompts are templates stored in Script Properties (ANALYSIS_PROMPT,
// COVER_LETTER_PROMPT, RESUME_TWEAKS_PROMPT) with {{placeholders}}
// filled in at run time. All background facts and writing rules come
// from the Candidate Knowledge doc sent as the system prompt.
// ============================================================

// Loads a prompt template. Literal \n in the stored value becomes a line break.
function getPromptTemplate_(name) {
  var template = PropertiesService.getScriptProperties().getProperty(name);
  if (!template) throw new Error('Missing Script Property "' + name + '". Add it in Project Settings > Script Properties.');
  return template.replace(/\\n/g, '\n');
}

function fillTemplate_(template, values) {
  var out = template;
  for (var key in values) {
    // split/join instead of replace() so values containing "$" (like "$200k") stay intact
    out = out.split('{{' + key + '}}').join(String(values[key]));
  }
  var leftover = out.match(/\{\{[a-zA-Z]+\}\}/g);
  if (leftover) Logger.log('Warning: unfilled placeholders in prompt: ' + leftover.join(', '));
  return out;
}

function buildAnalysisPrompt(company, roleTitle, jobUrl, content) {
  return fillTemplate_(getPromptTemplate_('ANALYSIS_PROMPT'), {
    company: company,
    roleTitle: roleTitle,
    jobUrl: jobUrl || 'Not provided',
    content: content
  });
}

function buildCoverLetterPrompt(company, roleTitle, jobContent, notes, analysis, roleType) {
  return fillTemplate_(getPromptTemplate_('COVER_LETTER_PROMPT'), {
    company: company,
    roleTitle: roleTitle,
    roleType: roleType,
    analysis: analysis,
    jobContentBlock: jobContent ? 'Job posting:\n' + jobContent.substring(0, 3000) + '\n\n' : '',
    notesBlock: (notes && notes.length > 30) ? 'Candidate\'s notes about this role:\n' + notes + '\n\n' : ''
  });
}

function buildResumeTweaksPrompt(company, roleTitle, jobContent, notes, analysis, roleType) {
  return fillTemplate_(getPromptTemplate_('RESUME_TWEAKS_PROMPT'), {
    company: company,
    roleTitle: roleTitle,
    roleType: roleType,
    analysis: analysis,
    jobContentBlock: jobContent ? 'Job posting:\n' + jobContent.substring(0, 3000) + '\n\n' : '',
    notesBlock: (notes && notes.length > 30) ? 'Candidate\'s notes about this role:\n' + notes + '\n\n' : ''
  });
}

// ============================================================
// CONTENT HELPERS
// ============================================================
function isUsableUrl(url) {
  var u = String(url || '').toLowerCase().trim();
  return u.length > 0 && u !== 'n/a' && u !== 'na' && u !== 'none' && u !== '-' && u !== 'tbd';
}

// Fetch a posting and strip it to plain text. Returns '' on failure
// (JavaScript rendered pages and login walls will come back empty).
function fetchJobContent(jobUrl, company) {
  try {
    var resp = UrlFetchApp.fetch(jobUrl, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('URL blocked for ' + company + ' (HTTP ' + resp.getResponseCode() + ')');
      return '';
    }
    var text = resp.getContentText()
      .replace(new RegExp('<script[^>]*>[\\s\\S]*?<\\/script>', 'gi'), ' ')
      .replace(new RegExp('<style[^>]*>[\\s\\S]*?<\\/style>', 'gi'), ' ')
      .replace(new RegExp('<[^>]+>', 'g'), ' ')
      .replace(new RegExp('\\s+', 'g'), ' ')
      .trim()
      .substring(0, 4000);
    Logger.log('URL fetched for ' + company + ' (' + text.length + ' chars)');
    return text;
  } catch (e) {
    Logger.log('URL fetch error for ' + company + ': ' + e.message);
    return '';
  }
}

// Priority: fetched posting > Job Description column > Notes
function buildEffectiveContent(fetchedContent, jobDesc, notes) {
  var hasJD = jobDesc.length > 30;
  var hasNotes = notes.length > 30;
  var out = '';
  if (fetchedContent.length > 100) {
    out = 'Job posting content:\n' + fetchedContent;
    if (hasJD) out += '\n\nAdditional job description:\n' + jobDesc;
    if (hasNotes) out += '\n\nCANDIDATE\'S NOTES:\n' + notes;
  } else if (hasJD) {
    out = 'Job description:\n' + jobDesc;
    if (hasNotes) out += '\n\nCANDIDATE\'S NOTES:\n' + notes;
  } else if (hasNotes) {
    out = 'Context from notes:\n' + notes;
  } else {
    out = 'No posting content available. Analyze on company name and role title only.';
  }
  return out;
}

// ============================================================
// CLAUDE API
// ============================================================

// Sends the Candidate Knowledge doc as the system prompt
function callClaudeWithKnowledge(prompt, maxTokens, knowledge, model) {
  var payload = {
    model: model || CLAUDE_MODEL,
    max_tokens: maxTokens,
    system: [{
      type: 'text',
      text: knowledge,
      cache_control: { type: 'ephemeral' }
    }],
    messages: [{ role: 'user', content: prompt }]
  };

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() !== 200) {
      Logger.log('Claude API error ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0, 300));
      return null;
    }

    var data = JSON.parse(resp.getContentText());
    return data.content
      .filter(function(block) { return block.type === 'text'; })
      .map(function(block) { return block.text; })
      .join('\n')
      .trim();
  } catch (e) {
    Logger.log('Claude call failed: ' + e.message);
    return null;
  }
}

// ============================================================
// HELPERS
// ============================================================
function extractFitScore(text) {
  var s = String(text || '');
  var m = s.match(/FIT\s*SCORE[:\s]*([0-9]+)/i);
  if (m) return parseInt(m[1]);
  var m2 = s.match(/([0-9]+)\s*of\s*10/i);
  if (m2) return parseInt(m2[1]);
  var m3 = s.match(/([0-9]+)\/10/);
  if (m3) return parseInt(m3[1]);
  return 0;
}

function isExecutiveRole(title) {
  var t = title.toLowerCase();
  return t.indexOf('cto') !== -1 || t.indexOf('vp') !== -1 || t.indexOf('vice president') !== -1 ||
         t.indexOf('chief') !== -1 || t.indexOf('director') !== -1 || t.indexOf('head of') !== -1;
}

// ============================================================
// UTILITY RESET FUNCTIONS
// ============================================================
function resetAnalysis() {
  var sheet = getJobsSheet();
  var lr = sheet.getLastRow();
  if (lr > 1) { sheet.getRange(2, COL_ANALYSIS, lr - 1, 1).clearContent(); Logger.log('Analysis cleared.'); }
}

function resetCoverLettersAndTweaks() {
  var sheet = getJobsSheet();
  var lr = sheet.getLastRow();
  if (lr > 1) { sheet.getRange(2, COL_RESUME_TWEAKS, lr - 1, 2).clearContent(); Logger.log('Cover letters and tweaks cleared.'); }
}

// Run manually to test the rule checker on any text
// Pass your own sample text, or edit the default, to see which rules fire.
function testRuleChecks(sample) {
  if (typeof sample !== 'string') {
    sample = 'I have spent 20 years leading teams -- and I am confident we should talk. Sincerely, ' + SIGNOFF_NAME;
  }
  var loaded = loadCoverLetterChecks_();
  Logger.log(loaded.error ? loaded.error : 'Loaded ' + loaded.rules.length + ' rule checks: ' +
             loaded.rules.map(function(r) { return r.label; }).join('; '));
  var cleaned = sanitizeDashes(sample);
  Logger.log('Sanitized: ' + cleaned);
  Logger.log('Issues: ' + (checkCoverLetterRules(cleaned).join('; ') || 'none'));
}
