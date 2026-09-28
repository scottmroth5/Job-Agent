// ============================================================
// CONFIGURATION
// Everything specific to the candidate lives in Project Settings > Script Properties.
// Required: ANTHROPIC_API_KEY, SERPER_API_KEY, DISCOVERED_SHEET_ID, JOB_HUNT_SHEET_ID,
//   YOUR_KNOWLEDGE_DOC_ID, EMAIL_ADDRESS, QUICK_SCORE_PROMPT, FULL_ANALYSIS_PROMPT,
//   SEARCH_TERMS, RELEVANT_TITLE_KEYWORDS, HOME_LOCATIONS
// Optional: NOISE_TITLE_KEYWORDS
// List properties are comma separated, e.g. "VP Engineering, CTO, Head of Engineering"
// ============================================================
function getSetting_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error('Missing Script Property "' + name + '". Add it in Project Settings > Script Properties.');
  return value.trim();
}

function getListSetting_(name, optional) {
  var raw = PropertiesService.getScriptProperties().getProperty(name);
  if (!raw || !raw.trim()) {
    if (optional) return [];
    throw new Error('Missing Script Property "' + name + '". Add it in Project Settings > Script Properties.');
  }
  return raw.split(',').map(function(v) { return v.trim(); }).filter(function(v) { return v.length > 0; });
}

var ANTHROPIC_API_KEY = getSetting_('ANTHROPIC_API_KEY');
var SERPER_API_KEY = getSetting_('SERPER_API_KEY');
var DISCOVERED_SHEET_ID = getSetting_('DISCOVERED_SHEET_ID');
var JOB_HUNT_SHEET_ID = getSetting_('JOB_HUNT_SHEET_ID');
var YOUR_KNOWLEDGE_DOC_ID = getSetting_('YOUR_KNOWLEDGE_DOC_ID');
var EMAIL_ADDRESS = getSetting_('EMAIL_ADDRESS');

// Search targeting
var SEARCH_TERMS = getListSetting_('SEARCH_TERMS');                   // titles searched on every source
var RELEVANT_TITLE_KEYWORDS = getListSetting_('RELEVANT_TITLE_KEYWORDS')
  .map(function(k) { return k.toLowerCase(); });                    // a title must contain one of these
var NOISE_TITLE_KEYWORDS = getListSetting_('NOISE_TITLE_KEYWORDS', true)
  .map(function(k) { return k.toLowerCase(); });                    // titles containing these are dropped
var HOME_LOCATIONS = getListSetting_('HOME_LOCATIONS');               // places that are never a location conflict

var JOB_HUNT_TAB_NAME = 'Jobs';
var SHEET_TAB_NAME = 'Sheet1';
var CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
var MIN_SCORE_FOR_FULL_ANALYSIS = 7;
var MIN_SCORE_FOR_EMAIL = 8;
var MIN_SCORE_FOR_PROMOTION = 8;
var MAX_CONTINUATIONS = 10;

// Job hunt sheet column indices (1-based)
// Discovered | Date Applied | Company | Role Title | Job URL |
// Job Description if URL does not work | Notes/Comments | Claude Analysis |
// Resume Tweaks | Cover Letter | Status
var JH_COL_DISCOVERED = 1;
var JH_COL_DATE_APPLIED = 2;
var JH_COL_COMPANY = 3;
var JH_COL_ROLE = 4;
var JH_COL_URL = 5;
var JH_COL_JD = 6;
var JH_COL_NOTES = 7;
var JH_COL_ANALYSIS = 8;
var JH_COL_RESUME_TWEAKS = 9;
var JH_COL_COVER_LETTER = 10;
var JH_COL_STATUS = 11;
var JH_TOTAL_COLS = 11;

// ============================================================
// COLUMN INDICES -- DISCOVERED JOBS SHEET (1-based)
// A=DateDiscovered, B=Source, C=Company, D=RoleTitle,
// E=Location, F=DatePosted, G=JobURL, H=Salary, I=JobType,
// J=FitScore, K=Analysis, L=Notes, M=Status
// ============================================================
var COL_DATE_DISC = 1;
var COL_SOURCE = 2;
var COL_COMPANY = 3;
var COL_ROLE = 4;
var COL_LOCATION = 5;
var COL_DATE_POSTED = 6;
var COL_URL = 7;
var COL_SALARY = 8;
var COL_JOB_TYPE = 9;
var COL_FIT_SCORE = 10;
var COL_ANALYSIS = 11;
var COL_NOTES = 12;
var COL_STATUS = 13;
var TOTAL_COLS = 13;

// ============================================================
// CANDIDATE KNOWLEDGE (Google Doc is the single source of truth)
// ============================================================
function getCandidateKnowledge() {
  return DocumentApp.openById(YOUR_KNOWLEDGE_DOC_ID).getBody().getText();
}

// Run this manually once to confirm the doc loads
function testCandidateKnowledge() {
  var text = getCandidateKnowledge();
  Logger.log('Loaded ' + text.length + ' characters. First line: ' + text.split('\n')[0]);
}

// ============================================================
// TRIGGER 1: DISCOVERY ONLY (runs 6am Mon/Thu)
// ============================================================
function runJobDiscovery() {
  Logger.log('Starting job discovery run...');
  var allJobs = [];
  allJobs = allJobs.concat(fetchHimalayas());
  allJobs = allJobs.concat(fetchRemoteOK());
  allJobs = allJobs.concat(fetchGoogleJobs());
  allJobs = allJobs.concat(fetchLinkedIn());
  Logger.log('Total raw jobs found: ' + allJobs.length);
  var newJobs = deduplicateJobs(allJobs);
  Logger.log('New jobs after deduplication: ' + newJobs.length);
  if (newJobs.length > 0) {
    writeJobsToSheet(newJobs);
  }
  var props = PropertiesService.getScriptProperties();
  var sourceCounts = { total: newJobs.length, himalayas: 0, remoteok: 0, google: 0, linkedin: 0 };
  for (var i = 0; i < newJobs.length; i++) {
    var src = newJobs[i].source.toLowerCase();
    if (src.indexOf('himalayas') !== -1) sourceCounts.himalayas++;
    else if (src.indexOf('remoteok') !== -1) sourceCounts.remoteok++;
    else if (src.indexOf('google') !== -1) sourceCounts.google++;
    else if (src.indexOf('linkedin') !== -1) sourceCounts.linkedin++;
  }
  props.setProperty('lastRunCounts', JSON.stringify(sourceCounts));
  props.setProperty('lastRunDate', new Date().toLocaleDateString());
  Logger.log('Discovery complete. ' + newJobs.length + ' new jobs written. Scoring runs in 1 hour.');
}

// ============================================================
// TRIGGER 2: SCORING + PROMOTION + EMAIL (runs 7am Mon/Thu)
// If a run nears the 6 minute limit, it schedules a continuation that
// resumes at the next unscored row. Promotion and the email run once,
// when scoring actually finishes.
// ============================================================
function scoreUnscoredJobs(isContinuation) {
  // The 7am trigger passes an event object, so only a literal true counts
  isContinuation = (isContinuation === true);

  deleteContinuationTriggers_();
  if (!isContinuation) {
    PropertiesService.getScriptProperties().deleteProperty('scoringContinuations');
  }

  var sheet = SpreadsheetApp.openById(DISCOVERED_SHEET_ID).getSheetByName(SHEET_TAB_NAME);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('No rows to score.');
    sendDiscoveryEmail();
    return;
  }

  // Load Candidate Knowledge once per run. If it fails, stop rather than
  // score every row without context.
  var knowledge = '';
  try {
    knowledge = getCandidateKnowledge();
  } catch (e) {
    Logger.log('Could not load Candidate Knowledge doc: ' + e.message + '. Scoring aborted.');
    return;
  }
  if (!knowledge || knowledge.length < 500) {
    Logger.log('Candidate Knowledge doc is empty or too short. Scoring aborted.');
    return;
  }

  var data = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
  var processed = 0;
  var startTime = new Date().getTime();
  var maxRunTime = 5 * 60 * 1000;

  for (var i = 0; i < data.length; i++) {
    if (new Date().getTime() - startTime > maxRunTime) {
      Logger.log('Time limit approaching at row ' + (i + 2) + '.');
      // Only chain if this run made progress; otherwise something is failing
      if (processed > 0 && scheduleScoringContinuation_()) {
        return;
      }
      Logger.log('Not continuing (no progress this run or cap reached). Finishing with what is scored.');
      finishScoringRun_(processed);
      return;
    }

    var row = data[i];
    var company = String(row[COL_COMPANY - 1] || '').trim();
    var roleTitle = String(row[COL_ROLE - 1] || '').trim();
    var jobUrl = String(row[COL_URL - 1] || '').trim();
    var jobLocation = String(row[COL_LOCATION - 1] || '').trim();
    var existingScore = String(row[COL_FIT_SCORE - 1] || '').trim();
    var status = String(row[COL_STATUS - 1] || '').toLowerCase();

    if (existingScore.length > 0) continue;
    if (!company || !roleTitle) continue;
    if (status.indexOf('rejected') !== -1) continue;

    Logger.log('Scoring: ' + company + ' | ' + roleTitle);

    // Fetch the posting once; used for the location override, the quick
    // score, and the full analysis.
    var fetchedContent = fetchJobContent(jobUrl, company);

    // Deterministic location check. A listed place outside HOME_LOCATIONS is only
    // auto rejected if the posting itself shows no sign the role can be remote.
    var locationNote = '';
    var locCheck = locationConflictCheck(jobLocation);
    if (locCheck.conflict) {
      if (hasRemoteSignal(fetchedContent)) {
        locationNote = 'The listed location is "' + jobLocation + '", but the posting text indicates the role ' +
          'can be remote. Treat it as remote eligible and mention this in the reason.';
        Logger.log('Location override: posting mentions remote for ' + company + ' (' + jobLocation + ')');
      } else {
        sheet.getRange(i + 2, COL_FIT_SCORE).setValue('2 of 10');
        sheet.getRange(i + 2, COL_ANALYSIS).setValue(
          '2 of 10. Location conflict: role appears based in "' + jobLocation +
          '", outside the ' + HOME_LOCATIONS.join(' / ') + ' / remote requirement, and the posting shows no remote option. Auto scored without AI call.'
        );
        Logger.log('Location conflict, auto scored 2 for ' + company + ' (' + jobLocation + ')');
        processed++;
        continue;
      }
    }

    var quickScore = getQuickScore(company, roleTitle, jobUrl, jobLocation, knowledge, fetchedContent, locationNote);
    if (quickScore === null) {
      Logger.log('Scoring failed for ' + company);
      continue;
    }

    sheet.getRange(i + 2, COL_FIT_SCORE).setValue(quickScore.score + ' of 10');
    Logger.log('Score: ' + quickScore.score + ' of 10 for ' + company);

    if (quickScore.score >= MIN_SCORE_FOR_FULL_ANALYSIS) {
      var fullAnalysis = getFullAnalysis(company, roleTitle, jobUrl, fetchedContent, quickScore.score, knowledge);
      if (fullAnalysis) {
        sheet.getRange(i + 2, COL_ANALYSIS).setValue(fullAnalysis);
        Logger.log('Full analysis written for ' + company);
      }
      Utilities.sleep(2000);
    } else {
      sheet.getRange(i + 2, COL_ANALYSIS).setValue(quickScore.score + ' of 10. ' + quickScore.reason);
      Utilities.sleep(1000);
    }
    processed++;
  }

  finishScoringRun_(processed);
}

// ============================================================
// SELF CONTINUATION
// ============================================================

// Handler for the one-time continuation triggers. A separate handler name
// means cleanup can never delete the recurring 7am scoreUnscoredJobs trigger.
function continueScoring() {
  scoreUnscoredJobs(true);
}

function scheduleScoringContinuation_() {
  var props = PropertiesService.getScriptProperties();
  var count = parseInt(props.getProperty('scoringContinuations') || '0', 10);
  if (count >= MAX_CONTINUATIONS) {
    Logger.log('Reached ' + MAX_CONTINUATIONS + ' continuations. Stopping the chain; run scoreUnscoredJobs manually to finish.');
    return false;
  }
  props.setProperty('scoringContinuations', String(count + 1));
  ScriptApp.newTrigger('continueScoring').timeBased().after(60 * 1000).create();
  Logger.log('Scheduled continuation ' + (count + 1) + ' of ' + MAX_CONTINUATIONS + ' in about 1 minute.');
  return true;
}

// One-time triggers stay listed after they fire, so clean them up each run
function deleteContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'continueScoring') ScriptApp.deleteTrigger(t);
  });
}

function finishScoringRun_(processed) {
  PropertiesService.getScriptProperties().deleteProperty('scoringContinuations');
  Logger.log('Scoring complete. Processed this run: ' + processed + ' rows.');
  promoteHighScoreJobs();
  Logger.log('Sending email...');
  sendDiscoveryEmail();
}

// ============================================================
// PROMOTE 8+ JOBS TO JOB HUNT SHEET
// ============================================================
function promoteHighScoreJobs() {
  var discoveredSheet = SpreadsheetApp.openById(DISCOVERED_SHEET_ID).getSheetByName(SHEET_TAB_NAME);
  var jobHuntSheet = SpreadsheetApp.openById(JOB_HUNT_SHEET_ID).getSheetByName(JOB_HUNT_TAB_NAME);

  var lastRow = discoveredSheet.getLastRow();
  if (lastRow < 2) return;

  // Build lookup of existing URLs and company+title in job hunt sheet
  var jhLastRow = jobHuntSheet.getLastRow();
  var existingUrls = {};
  var existingTitles = {};

  if (jhLastRow > 1) {
    var jhData = jobHuntSheet.getRange(2, 1, jhLastRow - 1, JH_TOTAL_COLS).getValues();
    for (var e = 0; e < jhData.length; e++) {
      var eUrl = String(jhData[e][JH_COL_URL - 1] || '').trim();
      var eTc = String(jhData[e][JH_COL_COMPANY - 1] || '').toLowerCase() + '|' +
                String(jhData[e][JH_COL_ROLE - 1] || '').toLowerCase();
      if (eUrl) existingUrls[eUrl] = true;
      if (eTc !== '|') existingTitles[eTc] = true;
    }
  }

  // Get today's run date from properties
  var props = PropertiesService.getScriptProperties();
  var lastRunDate = props.getProperty('lastRunDate') || new Date().toLocaleDateString();

  var data = discoveredSheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
  var promoted = 0;

  // Diagnostic: log first 5 rows to understand what we're working with
  Logger.log('Total rows to check: ' + data.length);
  for (var d = 0; d < Math.min(5, data.length); d++) {
    var dr = data[d];
    Logger.log('Row ' + (d+2) + ': company=' + dr[COL_COMPANY-1] + ' score=' + dr[COL_FIT_SCORE-1] + ' status=' + dr[COL_STATUS-1]);
  }

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var company = String(row[COL_COMPANY - 1] || '').trim();
    var roleTitle = String(row[COL_ROLE - 1] || '').trim();
    var jobUrl = String(row[COL_URL - 1] || '').trim();
    var scoreStr = String(row[COL_FIT_SCORE - 1] || '').trim();
    var analysis = String(row[COL_ANALYSIS - 1] || '').trim();
    var rowStatus = String(row[COL_STATUS - 1] || '').toLowerCase().trim();

    if (!company || !roleTitle) continue;

    // Skip already promoted or rejected rows
    if (rowStatus === 'added to pipeline' || rowStatus === 'rejected') {
      Logger.log('Skipping ' + company + ' -- status: ' + rowStatus);
      continue;
    }

    // Skip if no score yet
    if (!scoreStr) {
      Logger.log('Skipping ' + company + ' -- no score');
      continue;
    }

    // Extract numeric score -- must be 'X of 10' format exactly
    var sm = new RegExp('^([0-9]+) of 10$').exec(scoreStr);
    if (!sm) {
      Logger.log('Skipping ' + company + ' -- not a valid score: ' + scoreStr);
      continue;
    }
    var scoreNum = parseInt(sm[1]);
    Logger.log('Promotion check: ' + company + ' scoreStr=' + scoreStr + ' parsed=' + scoreNum + ' threshold=' + MIN_SCORE_FOR_PROMOTION);
    if (scoreNum < MIN_SCORE_FOR_PROMOTION) continue;

    // Skip if already in job hunt sheet
    var tc = company.toLowerCase() + '|' + roleTitle.toLowerCase();
    if (existingUrls[jobUrl] || existingTitles[tc]) {
      Logger.log('Already in pipeline -- skipping: ' + company + ' -- ' + roleTitle);
      continue;
    }

    // Add to job hunt sheet
    var jobType = String(row[COL_JOB_TYPE - 1] || 'Unknown').trim();
    var notesValue = 'Promoted from Job Discovery Agent | Fit Score: ' + scoreStr + ' | Job Type: ' + jobType + '\n\n' + analysis;
    jobHuntSheet.appendRow([
      new Date().toLocaleDateString(),  // Discovered
      '',                                // Date Applied
      company,                           // Company
      roleTitle,                         // Role Title
      jobUrl,                            // Job URL
      '',                                // Job Description if URL does not work
      notesValue,                        // Notes/Comments
      '',                                // Claude Analysis (filled by analyzeUnprocessedJobs)
      '',                                // Resume Tweaks
      '',                                // Cover Letter
      'New'                              // Status
    ]);

    // Mark as promoted in discovered sheet
    discoveredSheet.getRange(i + 2, COL_STATUS).setValue('Added to Pipeline');

    // Track as seen so we don't add duplicates within the same run
    existingUrls[jobUrl] = true;
    existingTitles[tc] = true;

    promoted++;
    Logger.log('Promoted to pipeline: ' + company + ' -- ' + roleTitle + ' (' + scoreStr + ')');
  }

  Logger.log('Promotion complete. ' + promoted + ' jobs added to the Job Hunt sheet.');
}

// ============================================================
// SOURCE 1: HIMALAYAS API (free, no auth required)
// ============================================================
function fetchHimalayas() {
  var jobs = [];
  var sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  for (var t = 0; t < SEARCH_TERMS.length; t++) {
    var term = SEARCH_TERMS[t];
    var encodedTerm = encodeURIComponent(term);
    var url = 'https://himalayas.app/jobs/api/search?q=' + encodedTerm +
              '&sort=recent&employment_type=Full%20Time,Part%20Time,Contractor';

    try {
      var response = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' }
      });

      if (response.getResponseCode() !== 200) {
        Logger.log('Himalayas error for ' + term + ': HTTP ' + response.getResponseCode());
        continue;
      }

      var data = JSON.parse(response.getContentText());
      var jobList = data.jobs || [];

      for (var j = 0; j < jobList.length; j++) {
        var job = jobList[j];
        var title = job.title || '';
        if (!isRelevantTitle(title)) continue;
        if (isNoiseTitle(title)) continue;

        var postedAt = job.postedAt || job.createdAt || '';
        if (postedAt) {
          var postDate = new Date(postedAt);
          if (postDate < sevenDaysAgo) continue;
        }

        var salary = '';
        if (job.minSalary && job.maxSalary) {
          salary = '$' + Math.round(job.minSalary / 1000) + 'k - $' + Math.round(job.maxSalary / 1000) + 'k';
        }

        jobs.push({
          source: 'Himalayas',
          company: job.companyName || 'See posting',
          title: title,
          location: 'Remote',
          jobType: job.employmentType || detectJobType(title, ''),
          url: job.applicationLink || ('https://himalayas.app/jobs/' + (job.slug || '')),
          datePosted: postedAt ? new Date(postedAt).toLocaleDateString() : new Date().toLocaleDateString(),
          salary: salary
        });
      }

      Logger.log('Himalayas (' + term + '): ' + jobList.length + ' returned');
      Utilities.sleep(1000);
    } catch(e) {
      Logger.log('Himalayas error for ' + term + ': ' + e.message);
    }
  }

  Logger.log('Himalayas total: ' + jobs.length + ' jobs');
  return jobs;
}

// ============================================================
// SOURCE 2: REMOTEOK API (free, no auth required)
// ============================================================
function fetchRemoteOK() {
  var jobs = [];
  var sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  try {
    var response = UrlFetchApp.fetch('https://remoteok.com/api', {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible)',
        'Accept': 'application/json'
      }
    });

    if (response.getResponseCode() !== 200) {
      Logger.log('RemoteOK HTTP ' + response.getResponseCode());
      return jobs;
    }

    var data = JSON.parse(response.getContentText());
    var jobList = Array.isArray(data) ? data.slice(1) : [];

    for (var j = 0; j < jobList.length; j++) {
      var job = jobList[j];
      if (!job || !job.position) continue;

      var title = job.position || '';
      if (!isRelevantTitle(title)) continue;
      if (isNoiseTitle(title)) continue;

      if (job.epoch) {
        var postDate = new Date(job.epoch * 1000);
        if (postDate < sevenDaysAgo) continue;
      }

      var salary = '';
      if (job.salary_min && job.salary_max) {
        salary = '$' + Math.round(job.salary_min / 1000) + 'k - $' + Math.round(job.salary_max / 1000) + 'k';
      }

      jobs.push({
        source: 'RemoteOK',
        company: job.company || 'See posting',
        title: title,
        location: 'Remote',
        jobType: detectJobType(title, (job.tags || []).join(' ')),
        url: job.url || job.apply_url || 'https://remoteok.com',
        datePosted: job.date ? new Date(job.date).toLocaleDateString() : new Date().toLocaleDateString(),
        salary: salary
      });
    }

    Logger.log('RemoteOK: ' + jobs.length + ' relevant jobs');
  } catch(e) {
    Logger.log('RemoteOK error: ' + e.message);
  }
  return jobs;
}

// ============================================================
// SOURCE 3: GOOGLE JOBS via Serper.dev
// ============================================================
function fetchGoogleJobs() {
  var jobs = [];
  var seen = {};

  for (var t = 0; t < SEARCH_TERMS.length; t++) {
    var term = SEARCH_TERMS[t];

    try {
      var response = UrlFetchApp.fetch('https://google.serper.dev/search', {
        method: 'post',
        muteHttpExceptions: true,
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        payload: JSON.stringify({
          q: term + ' remote jobs',
          gl: 'us',
          hl: 'en',
          tbs: 'qdr:w',
          num: 20
        })
      });

      if (response.getResponseCode() !== 200) {
        Logger.log('Serper.dev error for ' + term + ': HTTP ' + response.getResponseCode() + ' -- ' + response.getContentText().substring(0, 200));
        continue;
      }

      var data = JSON.parse(response.getContentText());
      var jobResults = data.jobs || data.organic || [];

      Logger.log('Serper.dev (' + term + '): ' + jobResults.length + ' results');
      if (jobResults.length > 0) {
        Logger.log('Serper sample fields: ' + JSON.stringify(Object.keys(jobResults[0])));
        Logger.log('Serper company fields: company_name=' + jobResults[0].company_name + ' companyName=' + jobResults[0].companyName + ' company=' + jobResults[0].company);
      }

      for (var j = 0; j < jobResults.length; j++) {
        var job = jobResults[j];
        var title = job.title || '';
        if (!isRelevantTitle(title)) continue;
        if (isNoiseTitle(title)) continue;

        var applyUrl = job.link || job.applyLink || job.apply_link || '';
        if (!applyUrl) applyUrl = 'https://www.google.com/search?q=' + encodeURIComponent(term + ' remote jobs') + '&ibp=htl;jobs';

        var key = (job.company_name || job.companyName || job.company || '') + '|' + title;
        if (seen[key] || seen[applyUrl]) continue;
        seen[key] = true;
        if (applyUrl) seen[applyUrl] = true;

        jobs.push({
          source: 'Google Jobs',
          company: job.company_name || job.companyName || job.company || 'See posting',
          title: title,
          location: job.location || 'Remote',
          jobType: job.employment_type || detectJobType(title, job.snippet || ''),
          url: applyUrl,
          datePosted: job.date || job.datePosted || new Date().toLocaleDateString(),
          salary: job.salary || ''
        });
      }

      Utilities.sleep(1200);
    } catch(e) {
      Logger.log('Serper.dev error for ' + term + ': ' + e.message);
    }
  }

  Logger.log('Google Jobs total: ' + jobs.length + ' jobs');
  return jobs;
}

// ============================================================
// SOURCE 4: LINKEDIN (public page scraping)
// ============================================================
function fetchLinkedIn() {
  var jobs = [];
  for (var t = 0; t < SEARCH_TERMS.length; t++) {
    var term = SEARCH_TERMS[t];
    var encodedTerm = encodeURIComponent(term);
    var url = 'https://www.linkedin.com/jobs/search/?keywords=' + encodedTerm +
              '&location=United%20States&f_TPR=r604800&f_WT=2&sortBy=DD';
    try {
      var response = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        }
      });
      if (response.getResponseCode() !== 200) {
        Logger.log('LinkedIn blocked for: ' + term + ' (HTTP ' + response.getResponseCode() + ')');
        continue;
      }
      var parsed = parseLinkedInHTML(response.getContentText(), term);
      jobs = jobs.concat(parsed);
      Logger.log('LinkedIn (' + term + '): ' + parsed.length + ' jobs');
      Utilities.sleep(2000);
    } catch(e) {
      Logger.log('LinkedIn error for ' + term + ': ' + e.message);
    }
  }
  return jobs;
}

// ============================================================
// LINKEDIN PARSER
// ============================================================
function parseLinkedInHTML(html, searchTerm) {
  var jobs = [];
  try {
    var jsonLdPattern = new RegExp('<script type=["\']application\\/ld\\+json["\']>([\\s\\S]*?)<\\/script>', 'gi');
    var jsonMatch;
    while ((jsonMatch = jsonLdPattern.exec(html)) !== null) {
      try {
        var jsonData = JSON.parse(jsonMatch[1]);
        var items = Array.isArray(jsonData) ? jsonData : [jsonData];
        for (var i = 0; i < items.length; i++) {
          var jd = items[i];
          if (jd['@type'] !== 'JobPosting') continue;
          if (!isRelevantTitle(jd.title || '')) continue;
          jobs.push({
            source: 'LinkedIn',
            company: jd.hiringOrganization ? jd.hiringOrganization.name : 'See posting',
            title: jd.title || searchTerm,
            location: (jd.jobLocationType === 'TELECOMMUTE')
              ? 'Remote'
              : ((jd.jobLocation && jd.jobLocation.address) ? jd.jobLocation.address.addressLocality : 'Remote'),
            jobType: detectJobType(jd.title || '', jd.description || ''),
            url: jd.url || 'https://www.linkedin.com/jobs/',
            datePosted: jd.datePosted ? new Date(jd.datePosted).toLocaleDateString() : new Date().toLocaleDateString(),
            salary: jd.baseSalary ? formatSalary(jd.baseSalary) : ''
          });
        }
      } catch(e) { /* skip */ }
    }

    if (jobs.length === 0) {
      var hrefPattern = new RegExp('href="(https:\\/\\/www\\.linkedin\\.com\\/jobs\\/view\\/[^"?]+)', 'gi');
      var seen = {};
      var hrefMatch;
      while ((hrefMatch = hrefPattern.exec(html)) !== null) {
        var jobUrl = hrefMatch[1];
        if (seen[jobUrl]) continue;
        seen[jobUrl] = true;
        var extractedCompany = extractCompanyFromLinkedInUrl(jobUrl);
        var extractedTitle = extractTitleFromLinkedInUrl(jobUrl);
        if (extractedTitle && !isRelevantTitle(extractedTitle)) continue;
        if (isNoiseTitle(extractedTitle)) continue;
        jobs.push({
          source: 'LinkedIn',
          company: extractedCompany,
          title: extractedTitle || searchTerm + ' role',
          location: 'Remote (unconfirmed)',
          jobType: detectJobType(extractedTitle || '', ''),
          url: jobUrl,
          datePosted: new Date().toLocaleDateString(),
          salary: ''
        });
      }
    }
  } catch(e) {
    Logger.log('LinkedIn parse error: ' + e.message);
  }
  return jobs;
}

// ============================================================
// DEDUPLICATION
// ============================================================
function deduplicateJobs(jobs) {
  var sheet = SpreadsheetApp.openById(DISCOVERED_SHEET_ID).getSheetByName(SHEET_TAB_NAME);
  var lastRow = sheet.getLastRow();
  var existingUrls = {};
  var existingTitles = {};

  if (lastRow > 1) {
    var existingData = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
    for (var i = 0; i < existingData.length; i++) {
      var eUrl = String(existingData[i][COL_URL - 1] || '').trim();
      var eTc = String(existingData[i][COL_COMPANY - 1] || '').toLowerCase() + '|' +
                String(existingData[i][COL_ROLE - 1] || '').toLowerCase();
      if (eUrl) existingUrls[eUrl] = true;
      if (eTc !== '|') existingTitles[eTc] = true;
    }
  }

  var newJobs = [];
  var seenThisRun = {};

  for (var j = 0; j < jobs.length; j++) {
    var job = jobs[j];
    var jobUrl = String(job.url || '').trim();
    var jobTc = String(job.company || '').toLowerCase() + '|' + String(job.title || '').toLowerCase();
    if (existingUrls[jobUrl]) continue;
    if (existingTitles[jobTc]) continue;
    if (seenThisRun[jobUrl || jobTc]) continue;
    seenThisRun[jobUrl || jobTc] = true;
    newJobs.push(job);
  }
  return newJobs;
}

// ============================================================
// WRITE TO DISCOVERED SHEET
// ============================================================
function writeJobsToSheet(jobs) {
  var sheet = SpreadsheetApp.openById(DISCOVERED_SHEET_ID).getSheetByName(SHEET_TAB_NAME);
  var today = new Date().toLocaleDateString();
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    sheet.appendRow([
      today, job.source, job.company, job.title, job.location,
      job.datePosted, job.url, job.salary, job.jobType || 'Unknown',
      '', '', '', 'New'
    ]);
  }
  Logger.log('Wrote ' + jobs.length + ' jobs to discovered sheet.');
}

// ============================================================
// EMAIL SUMMARY
// ============================================================
function sendDiscoveryEmail() {
  var today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  var todayStr = new Date().toLocaleDateString();

  var props = PropertiesService.getScriptProperties();
  var countsRaw = props.getProperty('lastRunCounts');
  var lastRunDate = props.getProperty('lastRunDate') || todayStr;
  var counts = { total: 0, himalayas: 0, remoteok: 0, google: 0, linkedin: 0 };
  if (countsRaw) {
    try { counts = JSON.parse(countsRaw); } catch(e) {}
  }

  var sheet = SpreadsheetApp.openById(DISCOVERED_SHEET_ID).getSheetByName(SHEET_TAB_NAME);
  var lastRow = sheet.getLastRow();
  var highScoreJobs = [];
  var promotedCount = 0;

  if (lastRow > 1) {
    var allData = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
    for (var d = 0; d < allData.length; d++) {
      var row = allData[d];
      var rowDate = String(row[COL_DATE_DISC - 1] || '').trim();
      if (rowDate !== lastRunDate && rowDate !== todayStr) continue;

      var status = String(row[COL_STATUS - 1] || '').trim();
      if (status === 'Added to Pipeline') promotedCount++;

      var scoreStr = String(row[COL_FIT_SCORE - 1] || '').trim();
      if (!scoreStr) continue;
      var sm = new RegExp('([0-9]+) of 10').exec(scoreStr);
      if (!sm) continue;
      var scoreNum = parseInt(sm[1]);
      if (scoreNum < MIN_SCORE_FOR_EMAIL) continue;

      highScoreJobs.push({
        company: String(row[COL_COMPANY - 1] || ''),
        title: String(row[COL_ROLE - 1] || ''),
        source: String(row[COL_SOURCE - 1] || ''),
        location: String(row[COL_LOCATION - 1] || ''),
        salary: String(row[COL_SALARY - 1] || ''),
        datePosted: String(row[COL_DATE_POSTED - 1] || ''),
        url: String(row[COL_URL - 1] || ''),
        fitScore: scoreNum,
        fitScoreStr: scoreStr,
        analysis: String(row[COL_ANALYSIS - 1] || ''),
        promoted: status === 'Added to Pipeline'
      });
    }
    highScoreJobs.sort(function(a, b) { return b.fitScore - a.fitScore; });
  }

  var html = '<div style="max-width:700px;margin:0 auto;font-family:Arial,sans-serif;">';

  // Header
  html += '<div style="background:#1a5276;padding:24px 28px;border-radius:6px 6px 0 0;">';
  html += '<h1 style="color:#fff;margin:0;font-size:22px;">Job Discovery Report</h1>';
  html += '<p style="color:#a9cce3;margin:6px 0 0;font-size:13px;">' + today + ' | AI scoring complete</p>';
  html += '</div>';

  // Counts
  html += '<div style="background:#f4f6f8;padding:20px 28px;border:1px solid #e0e0e0;">';
  html += '<div style="text-align:center;margin-bottom:16px;">';
  html += '<span style="font-size:40px;font-weight:bold;color:#1a5276;">' + counts.total + '</span>';
  html += '<span style="font-size:16px;color:#555;margin-left:10px;">new jobs found this run</span>';
  if (promotedCount > 0) {
    html += '<div style="margin-top:8px;font-size:13px;color:#27ae60;font-weight:bold;">';
    html += promotedCount + ' job' + (promotedCount > 1 ? 's' : '') + ' auto-promoted to your pipeline (score ' + MIN_SCORE_FOR_PROMOTION + '+)';
    html += '</div>';
  }
  html += '</div>';
  html += '<table style="width:100%;border-collapse:collapse;border-top:1px solid #ddd;"><tr>';
  var sources = [['Himalayas', counts.himalayas], ['RemoteOK', counts.remoteok], ['Google Jobs', counts.google], ['LinkedIn', counts.linkedin]];
  for (var s = 0; s < sources.length; s++) {
    html += '<td style="text-align:center;padding:10px 4px;">';
    html += '<div style="font-size:20px;font-weight:bold;color:#1a5276;">' + sources[s][1] + '</div>';
    html += '<div style="font-size:11px;color:#666;">' + sources[s][0] + '</div>';
    html += '</td>';
  }
  html += '</tr></table></div>';

  // Job listings
  html += '<div style="padding:20px 28px;background:#fff;border:1px solid #e0e0e0;border-top:none;">';

  if (highScoreJobs.length > 0) {
    html += '<h2 style="color:#1a5276;font-size:16px;border-bottom:2px solid #1a5276;padding-bottom:6px;margin-bottom:16px;">';
    html += 'Jobs Scoring ' + MIN_SCORE_FOR_EMAIL + '+ (' + highScoreJobs.length + ' of ' + counts.total + ')</h2>';

    for (var j = 0; j < highScoreJobs.length; j++) {
      var job = highScoreJobs[j];
      var scoreColor = job.fitScore >= 9 ? '#1e8449' : job.fitScore >= 8 ? '#27ae60' : '#e67e22';
      var bgColor = job.fitScore >= 8 ? '#f0fff4' : '#fffbf0';
      var borderColor = job.fitScore >= 8 ? '#a9dfbf' : '#fdebd0';

      html += '<div style="border:1px solid ' + borderColor + ';border-radius:4px;margin-bottom:14px;overflow:hidden;">';
      html += '<div style="background:' + bgColor + ';padding:10px 16px;display:flex;justify-content:space-between;align-items:center;">';
      html += '<div style="flex:1;">';
      html += '<a href="' + job.url + '" style="color:#1a5276;font-weight:bold;font-size:14px;text-decoration:none;">' + job.title + '</a>';
      if (job.company && job.company !== 'See posting') {
        html += '<span style="color:#444;font-size:13px;"> at ' + job.company + '</span>';
      }
      if (job.promoted) {
        html += '<span style="background:#27ae60;color:#fff;font-size:10px;padding:2px 6px;border-radius:8px;margin-left:8px;vertical-align:middle;">Added to pipeline</span>';
      }
      html += '</div>';
      html += '<span style="background:' + scoreColor + ';color:#fff;padding:3px 10px;border-radius:10px;font-size:13px;font-weight:bold;margin-left:12px;white-space:nowrap;">' + job.fitScoreStr + '</span>';
      html += '</div>';
      html += '<div style="padding:6px 16px;font-size:12px;color:#666;background:#fff;border-top:1px solid ' + borderColor + ';">';
      html += job.source + ' &nbsp;|&nbsp; ' + job.location;
      if (job.salary) html += ' &nbsp;|&nbsp; ' + job.salary;
      if (job.datePosted) html += ' &nbsp;|&nbsp; Posted: ' + job.datePosted;
      html += '</div>';
      if (job.analysis && job.analysis.length > 10) {
        html += '<div style="padding:10px 16px;font-size:13px;line-height:1.6;color:#333;white-space:pre-wrap;border-top:1px solid ' + borderColor + ';background:#fff;">' + job.analysis + '</div>';
      }
      html += '</div>';
    }
  } else if (counts.total > 0) {
    html += '<p style="color:#888;font-style:italic;margin:0;">No jobs scored ' + MIN_SCORE_FOR_EMAIL + '+ this run. ' + counts.total + ' jobs in your Discovered Jobs sheet.</p>';
  } else {
    html += '<p style="color:#888;font-style:italic;margin:0;">No new jobs found this run. Check back Monday/Thursday.</p>';
  }

  html += '</div>';
  html += '<div style="padding:12px 28px;background:#f4f6f8;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 6px 6px;">';
  html += '<p style="font-size:11px;color:#999;margin:0;text-align:center;">';
  html += 'Job Discovery Agent &middot; ' + MIN_SCORE_FOR_PROMOTION + '+ scores auto promoted to your Job Hunt sheet';
  html += '</p></div></div>';

  var subject = 'Job Discovery: ' + counts.total + ' jobs found';
  if (promotedCount > 0) subject += ' | ' + promotedCount + ' promoted to pipeline';
  else if (highScoreJobs.length > 0) subject += ' | ' + highScoreJobs.length + ' scored ' + MIN_SCORE_FOR_EMAIL + '+';
  subject += ' | ' + today;

  MailApp.sendEmail({ to: EMAIL_ADDRESS, subject: subject, htmlBody: html });
  Logger.log('Email sent. Total: ' + counts.total + ', Promoted: ' + promotedCount);
}

// ============================================================
// DETERMINISTIC LOCATION CHECK -- runs before AI scoring so a
// clear-cut conflict can never be overridden by role-fit enthusiasm
// ============================================================
function locationConflictCheck(jobLocation) {
  var loc = String(jobLocation || '').trim();
  if (!loc) return { conflict: false, uncertain: true };
  var lower = loc.toLowerCase();
  if (lower.indexOf('unconfirmed') !== -1) return { conflict: false, uncertain: true };
  if (lower.indexOf('remote') !== -1) return { conflict: false, uncertain: false };
  for (var h = 0; h < HOME_LOCATIONS.length; h++) {
    if (lower.indexOf(HOME_LOCATIONS[h].toLowerCase()) !== -1) return { conflict: false, uncertain: false };
  }
  // Any other specific place name is a hard conflict: onsite/hybrid
  // somewhere outside HOME_LOCATIONS and not marked remote.
  return { conflict: true, uncertain: false };
}

// Fetch a posting and strip it to plain text. Returns '' on failure
// (JavaScript rendered pages and login walls will come back empty).
function fetchJobContent(jobUrl, company) {
  if (!jobUrl) return '';
  try {
    var resp = UrlFetchApp.fetch(jobUrl, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (resp.getResponseCode() !== 200) return '';
    return resp.getContentText()
      .replace(new RegExp('<script[^>]*>[\\s\\S]*?<\\/script>', 'gi'), ' ')
      .replace(new RegExp('<style[^>]*>[\\s\\S]*?<\\/style>', 'gi'), ' ')
      .replace(new RegExp('<[^>]+>', 'g'), ' ')
      .replace(new RegExp('\\s+', 'g'), ' ')
      .trim()
      .substring(0, 4000);
  } catch (e) {
    Logger.log('Content fetch failed for ' + company + ': ' + e.message);
    return '';
  }
}

// Looks for phrases that mean the ROLE can be remote. Deliberately avoids
// matching the bare word "remote" so industry terms like
// "remote patient monitoring" don't trigger a false override.
function hasRemoteSignal(text) {
  if (!text) return false;
  var t = text.toLowerCase();
  var signals = [
    'open to remote', 'open to it being remote', 'remote for the right', 'can be remote',
    'fully remote', 'remote position', 'remote role', 'remote opportunity', 'remote eligible',
    'remote first', 'remote-first', 'work from home', 'work from anywhere', 'telecommute',
    'this is a remote', 'remote (work from home)', 'remote within the us', 'remote in the us',
    'remote, us', 'remote us', 'hiring a remote'
  ];
  for (var i = 0; i < signals.length; i++) {
    if (t.indexOf(signals[i]) !== -1) return true;
  }
  return false;
}

// ============================================================
// AI SCORING
// Prompts are templates stored in Script Properties (QUICK_SCORE_PROMPT,
// FULL_ANALYSIS_PROMPT) with {{placeholders}} filled in at run time.
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

function getQuickScore(company, roleTitle, jobUrl, jobLocation, knowledge, content, locationNote) {
  var prompt = fillTemplate_(getPromptTemplate_('QUICK_SCORE_PROMPT'), {
    company: company,
    roleTitle: roleTitle,
    jobLocation: jobLocation || 'Not specified',
    jobUrl: jobUrl || 'Not provided',
    locationNoteBlock: locationNote
      ? 'LOCATION NOTE (overrides location rule 1 below): ' + locationNote + '\n\n'
      : '',
    jobContentBlock: content
      ? 'Job content:\n' + content + '\n\n'
      : 'No job content available; score on company, title, and location only.\n\n'
  });

  var result = callClaudeWithKnowledge(prompt, 150, knowledge);
  if (!result) return null;

  var scoreMatch = new RegExp('SCORE:\\s*([0-9]+)', 'i').exec(result);
  var reasonMatch = new RegExp('REASON:\\s*(.+)', 'i').exec(result);

  return {
    score: scoreMatch ? parseInt(scoreMatch[1]) : 5,
    reason: reasonMatch ? reasonMatch[1].trim() : 'No reason provided'
  };
}

function getFullAnalysis(company, roleTitle, jobUrl, content, quickScore, knowledge) {
  var prompt = fillTemplate_(getPromptTemplate_('FULL_ANALYSIS_PROMPT'), {
    company: company,
    roleTitle: roleTitle,
    jobUrl: jobUrl || 'Not provided',
    quickScore: quickScore,
    jobContentBlock: content
      ? 'Job content:\n' + content
      : 'No content available; analyze based on company and title only.'
  });

  return callClaudeWithKnowledge(prompt, 300, knowledge);
}

// ============================================================
// CLAUDE API
// ============================================================

// Used by scoring: sends the Candidate Knowledge doc as the system prompt
function callClaudeWithKnowledge(prompt, maxTokens, knowledge) {
  var payload = {
    model: CLAUDE_MODEL,
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

// General purpose call with no system prompt (kept for any other uses)
function callClaude(prompt, maxTokens) {
  try {
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      }),
      muteHttpExceptions: true
    });
    var data = JSON.parse(response.getContentText());
    if (data && data.content && data.content[0]) return data.content[0].text;
    if (data && data.error) Logger.log('Claude API error: ' + data.error.message);
  } catch(e) {
    Logger.log('Claude call failed: ' + e.message);
  }
  return null;
}

// ============================================================
// HELPERS
// ============================================================
function detectJobType(title, description) {
  var t = (title + ' ' + (description || '')).toLowerCase();
  if (t.indexOf('fractional') !== -1) return 'Fractional';
  if (t.indexOf('interim') !== -1) return 'Interim';
  if (t.indexOf('contract') !== -1 || t.indexOf('contractor') !== -1) return 'Contract';
  if (t.indexOf('part-time') !== -1 || t.indexOf('part time') !== -1) return 'Part-time';
  if (t.indexOf('full-time') !== -1 || t.indexOf('full time') !== -1) return 'Full-time';
  if (t.indexOf('temporary') !== -1 || t.indexOf('temp ') !== -1) return 'Contract';
  return 'Unknown';
}

function isRelevantTitle(title) {
  var t = String(title || '').toLowerCase();
  for (var i = 0; i < RELEVANT_TITLE_KEYWORDS.length; i++) {
    if (t.indexOf(RELEVANT_TITLE_KEYWORDS[i]) !== -1) return true;
  }
  return false;
}

function isNoiseTitle(title) {
  if (!title) return false;
  var t = title.toLowerCase();
  for (var i = 0; i < NOISE_TITLE_KEYWORDS.length; i++) {
    if (t.indexOf(NOISE_TITLE_KEYWORDS[i]) !== -1) return true;
  }
  return false;
}

function extractCompanyFromLinkedInUrl(url) {
  try {
    var pathMatch = new RegExp('\\/jobs\\/view\\/([^?#]+)').exec(url);
    if (!pathMatch) return 'See posting';
    var slug = pathMatch[1].replace(new RegExp('-[0-9]+$'), '');
    var atIndex = slug.lastIndexOf('-at-');
    if (atIndex === -1) return 'See posting';
    var companySlug = slug.substring(atIndex + 4);
    var company = companySlug.split('-').map(function(w) {
      return w.length === 0 ? '' : w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ').trim();
    return company || 'See posting';
  } catch(e) { return 'See posting'; }
}

function extractTitleFromLinkedInUrl(url) {
  try {
    var pathMatch = new RegExp('\\/jobs\\/view\\/([^?#]+)').exec(url);
    if (!pathMatch) return '';
    var slug = pathMatch[1].replace(new RegExp('-[0-9]+$'), '');
    var atIndex = slug.lastIndexOf('-at-');
    var titleSlug = atIndex !== -1 ? slug.substring(0, atIndex) : slug;
    titleSlug = titleSlug.replace(/%E2%80%93/g, '-').replace(/%20/g, ' ');
    try { titleSlug = decodeURIComponent(titleSlug); } catch(e) {}
    return titleSlug.split('-').map(function(w) {
      return w.length === 0 ? '' : w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ').trim();
  } catch(e) { return ''; }
}

function formatSalary(salaryObj) {
  try {
    if (salaryObj.value) {
      var val = salaryObj.value;
      if (val.minValue && val.maxValue) return '$' + Math.round(val.minValue / 1000) + 'k - $' + Math.round(val.maxValue / 1000) + 'k';
      if (val.value) return '$' + Math.round(val.value / 1000) + 'k';
    }
  } catch(e) {}
  return '';
}

// ============================================================
// UTILITIES
// ============================================================
function clearDiscoveredJobs() {
  var sheet = SpreadsheetApp.openById(DISCOVERED_SHEET_ID).getSheetByName(SHEET_TAB_NAME);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).clearContent();
    Logger.log('All jobs cleared.');
  }
}

function resetScores() {
  var sheet = SpreadsheetApp.openById(DISCOVERED_SHEET_ID).getSheetByName(SHEET_TAB_NAME);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, COL_FIT_SCORE, lastRow - 1, 2).clearContent();
    Logger.log('Scores and analyses cleared.');
  }
}

function fixExistingSeePostingCompanies() {
  var sheet = SpreadsheetApp.openById(DISCOVERED_SHEET_ID).getSheetByName(SHEET_TAB_NAME);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var data = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
  var fixed = 0;
  for (var i = 0; i < data.length; i++) {
    var company = String(data[i][COL_COMPANY - 1] || '').trim();
    var source = String(data[i][COL_SOURCE - 1] || '').trim();
    var url = String(data[i][COL_URL - 1] || '').trim();
    var datePosted = String(data[i][COL_DATE_POSTED - 1] || '').trim();
    if (company === 'See posting' && source === 'LinkedIn' && url) {
      var extracted = extractCompanyFromLinkedInUrl(url);
      if (extracted !== 'See posting') {
        sheet.getRange(i + 2, COL_COMPANY).setValue(extracted);
        var extractedTitle = extractTitleFromLinkedInUrl(url);
        if (extractedTitle) sheet.getRange(i + 2, COL_ROLE).setValue(extractedTitle);
        fixed++;
      }
    }
    if (datePosted === 'Recent') {
      var discDate = String(data[i][COL_DATE_DISC - 1] || '').trim();
      sheet.getRange(i + 2, COL_DATE_POSTED).setValue(discDate || new Date().toLocaleDateString());
    }
  }
  Logger.log('Fixed ' + fixed + ' rows.');
}
