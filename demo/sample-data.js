// The public demo's sample job search: a fictional candidate and fictional companies. Every name, place, and
// figure here is invented. Dates are days before the seed runs, so the demo always looks current.
// scripts/demo-seed.js turns this into a database; nothing here is ever read by the real app.

export const CANDIDATE = {
  name: 'Jordan Avery',
  signoffName: 'Jordan Avery',
  contactLine: 'Riverton, ST | jordan.avery@example.com | 555-0142',
  linkedin: 'linkedin.com/in/example-jordan-avery',
};

export const DEMO_CONFIG = {
  candidate: CANDIDATE,
  search: {
    terms: ['VP Engineering', 'Head of Engineering', 'Director of Engineering', 'CTO'],
    relevantTitleKeywords: ['engineering', 'technology', 'cto', 'platform'],
    noiseTitleKeywords: ['intern', 'sales', 'recruiter'],
    homeAreaLabel: 'the Riverton area (Riverton, ST and nearby suburbs)',
    localSearchLocation: 'Riverton Metropolitan Area',
    homeLocations: ['Riverton Metro Area', 'Riverton, ST', 'Lakeside, ST', 'Millbrook, ST'],
    fractionalTerms: ['Fractional CTO', 'Fractional VP Engineering', 'Fractional Head of Engineering'],
    fractionalTitleKeywords: ['fractional', 'technical advisor', 'interim'],
    siteSearch: false,
    excludedSites: [],
  },
  fractional: { targetAnnual: [200000, 250000], weeksPerYear: 48 },
  coverLetterChecks: [{ label: '"I am confident"', text: "\\bi am confident\\b|\\bi'm confident\\b" }],
  privateTerms: [],
  allowTerms: [],
};

// What each company does, for descriptions and letters.
const C = {
  'Brightwater Diagnostics': 'a clinical lab network running genetic and molecular testing for 400 hospitals',
  'Cobalt Care Partners': 'a value based primary care group serving 90,000 Medicare patients',
  'Fernhill Health': 'a remote patient monitoring platform for cardiology and pulmonology practices',
  'Lumen Pathways': 'a K-12 learning platform used by 1,200 school districts',
  'Harborline Logistics': 'a freight visibility platform tracking 2 million shipments a month',
  'Quillstone Software': 'a document automation platform for mid market law firms',
  'Sagebrush Analytics': 'a data platform for regional hospital systems',
  'Tidewater Biotech': 'an oncology diagnostics startup moving from research to commercial launch',
  'Northgate Benefits': 'an employee benefits marketplace for small businesses',
  'Pinecrest Pharmacy Services': 'a specialty pharmacy with a patient adherence app',
  'Arbor Clinical Trials': 'a site network that runs decentralized clinical trials',
  'Meridian Home Health': 'a home health agency platform covering 14 states',
  'Ridgeview Robotics': 'an industrial automation company building warehouse robots',
  'Ostrander Labs': 'a seed stage startup building AI scheduling for outpatient clinics',
  'Willowmere Insurance': 'a regional insurer modernizing its claims systems',
  'Cardinal Youth Sports': 'a registration and scheduling platform for youth sports leagues',
  'Glasswing Health': 'a womens health company pairing at home tests with telehealth visits',
  'Stonebridge Fintech': 'a payments company serving community banks',
  'Elmstead Learning': 'a workforce training platform for healthcare employers',
  'Blue Heron Labs': 'a pharmacogenomics lab selling to psychiatry practices',
  'Copperline Energy': 'a utility analytics company',
  'Juniper Behavioral Health': 'a virtual mental health provider covering 30 states',
  'Halcyon Imaging': 'an outpatient radiology group with 40 imaging centers',
  'Marlow Ticketing': 'a live event ticketing platform',
  'Foxglove Nutrition': 'a consumer wellness subscription app',
  'Kestrel Security': 'a managed security services provider',
  'Larkspur Medical Billing': 'a revenue cycle company for physician groups',
  'Oakhaven Senior Living': 'a senior living operator with 60 communities',
  'Prairie Wind Health Plan': 'a nonprofit health plan',
  'Redfern Marketplaces': 'a two sided marketplace for home services',
  'Sterling Hollow Advisors': 'a private equity firm placing interim technology leaders in portfolio companies',
  'Thistle Genomics': 'a genomics data company serving research hospitals',
  'Umber Retail Tech': 'a retail point of sale platform',
  'Vantage Point Clinics': 'an urgent care network with 75 locations',
  'Wrenfield Telehealth': 'a telehealth platform for rural hospitals',
  'Yarrow Health Data': 'a health information exchange operator',
};

export const companyBlurb = (company) => C[company] ?? 'a growing technology company';

// The jobs. days = discovered this many days ago; applied = applied this many days ago.
// history: later statuses with days ago. emails: messages linked to the job. Scores follow the real scale:
// 7 and up is promoted to the pipeline.
export const JOBS = [
  // Active pipeline: offer, interviews, applications, and jobs to evaluate.
  {
    company: 'Brightwater Diagnostics', title: 'VP of Engineering', status: 'offer', stage: 'pipeline', score: 9, days: 28, applied: 26,
    location: 'Remote (US)', workplace: 'remote', source: 'LinkedIn', salary: '$235,000 - $265,000',
    history: [['interviewing', 19], ['offer', 3]],
    emails: [['interview_request', 20, 'Next steps for VP of Engineering', 'Recruiter asked for availability for a first round with the CTO.'], ['offer', 3, 'Offer letter: VP of Engineering', 'Written offer with base, bonus, and equity; reply requested within a week.']],
    notes: [[19, 'First round with the CTO went well. They are consolidating three lab systems and need someone who has done it before.'], [9, 'Final panel with the CEO, COO, and lab director. Asked a lot about inspection readiness.'], [3, 'Offer in hand. Base is at the top of the posted range; equity details still to come.']],
    letter: true, tweaks: true, prep: 'interview',
  },
  {
    company: 'Fernhill Health', title: 'Head of Engineering', status: 'interviewing', stage: 'pipeline', score: 9, days: 22, applied: 20,
    location: 'Remote (US)', workplace: 'remote', source: 'Himalayas', salary: '$220,000 - $250,000',
    history: [['interviewing', 9]],
    emails: [['interview_request', 9, 'Interview: Head of Engineering', 'Hiring manager invited a 45 minute video call next Tuesday.']],
    notes: [[9, 'Team of 22 across the US and Portugal. Device integrations are the bottleneck.']],
    letter: true, tweaks: true, prep: 'interview', reminder: ['interview', -4, 'Panel interview with the product and clinical leads'],
  },
  {
    company: 'Glasswing Health', title: 'CTO', status: 'interviewing', stage: 'pipeline', score: 8, days: 18, applied: 17,
    location: 'Remote (US)', workplace: 'remote', source: 'manual',
    history: [['interviewing', 6]],
    emails: [['recruiter_outreach', 18, 'Confidential CTO search', 'Search firm reached out about a CTO role at an early stage womens health company.'], ['interview_request', 6, 'Meet the founders', 'Founders proposed an in person working session.']],
    notes: [[18, 'Came in through a search firm. Series A, 14 engineers, HIPAA and SOC 2 still ahead.']],
    letter: true, tweaks: false,
  },
  {
    company: 'Arbor Clinical Trials', title: 'SVP, Technology', status: 'interviewing', stage: 'pipeline', score: 8, days: 27, applied: 25,
    location: 'Hybrid, Riverton, ST', workplace: 'hybrid', source: 'LinkedIn', salary: '$240,000 - $280,000',
    history: [['interviewing', 14]],
    emails: [['interview_request', 14, 'SVP Technology: first conversation', 'Talent partner scheduled a screen with the CEO.'], ['assessment', 5, 'Case exercise for the SVP Technology role', 'Take home case: a 90 day plan for the site platform, due Friday.']],
    letter: true, tweaks: true, prep: 'case', reminder: ['assessment', -2, 'Send the 90 day plan case'],
  },
  {
    company: 'Blue Heron Labs', title: 'Director of Software Engineering', status: 'applied', stage: 'pipeline', score: 9, days: 9, applied: 8,
    location: 'Remote (US)', workplace: 'remote', source: 'Google Jobs', salary: '$190,000 - $215,000',
    emails: [['confirmation', 8, 'Thanks for applying to Blue Heron Labs', 'Application received.']],
    letter: true, tweaks: true,
  },
  {
    company: 'Cobalt Care Partners', title: 'VP, Platform Engineering', status: 'applied', stage: 'pipeline', score: 8, days: 15, applied: 14,
    location: 'Remote (US)', workplace: 'remote', source: 'LinkedIn', salary: '$210,000 - $240,000',
    emails: [['confirmation', 14, 'Your application to Cobalt Care Partners', 'Application received.']],
    letter: true, tweaks: true,
  },
  {
    company: 'Sagebrush Analytics', title: 'Head of Engineering', status: 'applied', stage: 'pipeline', score: 8, days: 12, applied: 11,
    location: 'Remote (US)', workplace: 'remote', source: 'Himalayas',
    letter: true, tweaks: true,
  },
  {
    company: 'Tidewater Biotech', title: 'VP Engineering', status: 'applied', stage: 'pipeline', score: 7, days: 6, applied: 5,
    location: 'Remote (US)', workplace: 'remote', source: 'LinkedIn', salary: '$200,000 - $230,000',
    letter: true, tweaks: true,
  },
  {
    company: 'Wrenfield Telehealth', title: 'Fractional CTO', track: 'fractional', status: 'applied', stage: 'pipeline', score: 8, days: 10, applied: 9,
    location: 'Remote (US)', workplace: 'remote', source: 'Fractional Jobs', rate: ['$175 - $200 / hr', 175, 200, 'hour'], hours: [15, 20], fit: 'High',
    letter: true, tweaks: false,
  },
  {
    company: 'Yarrow Health Data', title: 'Director of Engineering, Interoperability', status: 'new', stage: 'pipeline', score: 9, days: 2,
    location: 'Remote (US)', workplace: 'remote', source: 'LinkedIn', salary: '$185,000 - $210,000',
    letter: true, tweaks: true,
  },
  {
    company: 'Halcyon Imaging', title: 'Sr. Director, Clinical Systems', status: 'new', stage: 'pipeline', score: 8, days: 1,
    location: 'Hybrid, Lakeside, ST', workplace: 'hybrid', source: 'Google Jobs',
    letter: true, tweaks: true,
  },
  {
    company: 'Elmstead Learning', title: 'VP of Engineering', status: 'new', stage: 'pipeline', score: 7, days: 3,
    location: 'Remote (US)', workplace: 'remote', source: 'RemoteOK', salary: '$200,000 - $225,000',
    letter: true, tweaks: true,
  },
  {
    company: 'Ostrander Labs', title: 'Founding CTO', status: 'new', stage: 'pipeline', score: 7, days: 4,
    location: 'Remote (US)', workplace: 'remote', source: 'manual', roleType: 'Founding CTO',
    letter: false, tweaks: false,
  },
  {
    company: 'Sterling Hollow Advisors', title: 'Interim VP Engineering (portfolio company)', track: 'fractional', status: 'new', stage: 'pipeline', score: 7, days: 5,
    location: 'Remote (US)', workplace: 'remote', source: 'Fractional Jobs', rate: ['$15,000 / month', 15000, 15000, 'month'], hours: [30, 40], fit: 'Medium',
    letter: false, tweaks: false,
  },
  {
    company: 'Juniper Behavioral Health', title: 'Fractional Head of Engineering', track: 'fractional', status: 'interviewing', stage: 'pipeline', score: 8, days: 20, applied: 19,
    location: 'Remote (US)', workplace: 'remote', source: 'Fractional Jobs', rate: ['$185 / hr', 185, 185, 'hour'], hours: [20, 20], fit: 'High',
    history: [['interviewing', 7]],
    emails: [['interview_request', 7, 'Intro call: fractional engineering lead', 'COO asked for a 30 minute intro call.']],
    letter: true, tweaks: false,
  },

  // Found: scored below the promotion line, or waiting on a description.
  { company: 'Harborline Logistics', title: 'Director of Engineering', status: 'new', stage: 'discovered', score: 6, days: 2, location: 'Remote (US)', workplace: 'remote', source: 'LinkedIn', salary: '$180,000 - $200,000' },
  { company: 'Quillstone Software', title: 'VP Engineering', status: 'new', stage: 'discovered', score: 5, days: 3, location: 'Remote (US)', workplace: 'remote', source: 'Himalayas' },
  { company: 'Northgate Benefits', title: 'Head of Platform', status: 'new', stage: 'discovered', score: 6, days: 4, location: 'Hybrid, Riverton, ST', workplace: 'hybrid', source: 'Google Jobs' },
  { company: 'Ridgeview Robotics', title: 'Director, Software Engineering', status: 'new', stage: 'discovered', score: 4, days: 5, location: 'Onsite, Millbrook, ST', workplace: 'onsite', source: 'LinkedIn' },
  { company: 'Copperline Energy', title: 'Engineering Manager, Data Platform', status: 'new', stage: 'discovered', score: 5, days: 6, location: 'Remote (US)', workplace: 'remote', source: 'RemoteOK' },
  { company: 'Umber Retail Tech', title: 'VP of Technology', status: 'new', stage: 'discovered', score: 4, days: 7, location: 'Onsite, Bay City, ST', workplace: 'onsite', source: 'LinkedIn' },
  { company: 'Kestrel Security', title: 'Director of Engineering', status: 'new', stage: 'discovered', score: 6, days: 8, location: 'Remote (US)', workplace: 'remote', source: 'Himalayas' },
  { company: 'Foxglove Nutrition', title: 'Head of Engineering', status: 'new', stage: 'discovered', score: 3, days: 9, location: 'Remote (US)', workplace: 'remote', source: 'RemoteOK' },
  { company: 'Redfern Marketplaces', title: 'VP Engineering', status: 'new', stage: 'discovered', score: 5, days: 10, location: 'Remote (US)', workplace: 'remote', source: 'LinkedIn', salary: '$190,000 - $220,000' },
  { company: 'Thistle Genomics', title: 'Director of Engineering', status: 'new', stage: 'discovered', score: 8, days: 1, location: 'Remote (US)', workplace: 'remote', source: 'LinkedIn', noText: true },
  { company: 'Vantage Point Clinics', title: 'VP, Technology', status: 'new', stage: 'discovered', score: 7, days: 2, location: 'Hybrid, Riverton, ST', workplace: 'hybrid', source: 'Google Jobs', noText: true },

  // Archived: passed, rejected, closed.
  { company: 'Lumen Pathways', title: 'Senior Engineering Manager, Platform', status: 'rejected', stage: 'archived', score: 7, days: 30, applied: 28, location: 'Remote (US)', workplace: 'remote', source: 'LinkedIn', history: [['rejected', 15]], emails: [['rejection', 15, 'Update on your application', 'Position filled by an internal candidate.']], letter: true, tweaks: true },
  { company: 'Marlow Ticketing', title: 'Director of Engineering', status: 'rejected', stage: 'archived', score: 7, days: 44, applied: 42, location: 'Remote (US)', workplace: 'remote', source: 'Himalayas', history: [['interviewing', 35], ['rejected', 24]], emails: [['interview_request', 35, 'Interview invitation', 'Recruiter screen scheduled.'], ['rejection', 24, 'Director of Engineering role', 'Moving forward with candidates with ticketing experience.']], letter: true, tweaks: true },
  { company: 'Cardinal Youth Sports', title: 'Head of Engineering', status: 'rejected', stage: 'archived', score: 8, days: 52, applied: 50, location: 'Remote (US)', workplace: 'remote', source: 'LinkedIn', history: [['interviewing', 40], ['rejected', 29]], emails: [['interview_request', 40, 'Next steps', 'Hiring manager call scheduled.'], ['rejection', 29, 'Thank you', 'They chose a candidate already in the industry.']], letter: true, tweaks: true },
  { company: 'Pinecrest Pharmacy Services', title: 'VP of Engineering', status: 'closed', stage: 'archived', score: 7, days: 55, applied: 53, location: 'Remote (US)', workplace: 'remote', source: 'Google Jobs', history: [['closed', 20]], letter: true, tweaks: true, closeNote: 'No response in five weeks; the posting came down.' },
  { company: 'Willowmere Insurance', title: 'Director of Engineering', status: 'passed', stage: 'archived', score: 7, days: 36, location: 'Onsite, Bay City, ST', workplace: 'onsite', source: 'LinkedIn', history: [['passed', 34]], closeNote: 'Five days a week onsite, two hours away.' },
  { company: 'Meridian Home Health', title: 'CTO', status: 'rejected', stage: 'archived', score: 8, days: 60, applied: 58, location: 'Remote (US)', workplace: 'remote', source: 'manual', history: [['interviewing', 49], ['rejected', 38]], emails: [['interview_request', 49, 'CTO search: next steps', 'Board member asked for an introductory call.'], ['rejection', 38, 'CTO search update', 'The board decided to promote from within.']], letter: true, tweaks: true },
  { company: 'Larkspur Medical Billing', title: 'VP Engineering', status: 'passed', stage: 'archived', score: 6, days: 40, location: 'Remote (US)', workplace: 'remote', source: 'Himalayas', history: [['passed', 39]] },
  { company: 'Oakhaven Senior Living', title: 'Director of IT', status: 'passed', stage: 'archived', score: 4, days: 31, location: 'Onsite, Riverton, ST', workplace: 'onsite', source: 'LinkedIn', history: [['passed', 30]] },
  { company: 'Prairie Wind Health Plan', title: 'VP, Enterprise Architecture', status: 'rejected', stage: 'archived', score: 7, days: 47, applied: 45, location: 'Hybrid, Lakeside, ST', workplace: 'hybrid', source: 'Google Jobs', history: [['rejected', 26]], emails: [['rejection', 26, 'Your application', 'Not moving forward.']], letter: true, tweaks: true },
  { company: 'Stonebridge Fintech', title: 'Head of Engineering', status: 'applied', stage: 'archived', score: 7, days: 58, applied: 56, location: 'Remote (US)', workplace: 'remote', source: 'LinkedIn', letter: true, tweaks: true },
];

/** One email that the inbox could not place, to show the review queue. */
export const REVIEW_EMAIL = {
  days: 1,
  sender: 'talent@example-recruiting.com',
  subject: 'Quick question about your background',
  summary: 'A recruiter asks for a call about an unnamed Head of Engineering role; no company is mentioned.',
  type: 'recruiter_outreach',
  reason: 'No company or job title to match against open applications',
};

// The candidate's background, used to write the sample analyses, letters, and tweaks.
export const STRENGTHS = [
  'Grew a care coordination platform team from 6 engineers to 45',
  'Led the technology side of a lab accreditation with no findings',
  'Cut claims processing time by 60 percent with a rebuilt rules engine',
  'Has run distributed teams across the United States, Poland, and Colombia',
  'Took a venture backed company through a successful acquisition',
  'Built FHIR integrations with more than 20 health systems',
  'Hands on with TypeScript, Python, and Java; comfortable in any stack',
  'Ran SOC 2 Type II and HIPAA programs as the security lead',
];
// Watch-outs that fit any posting; a location watch-out comes only from the job's own workplace (scripts/demo-seed.js).
export const WATCH_OUTS = [
  'No direct experience with this company\'s market',
  'Role reports to a CTO, a step down in scope',
  'Posting asks for Go and Kubernetes depth',
  'Early stage: compensation is mostly equity',
  'Team is entirely offshore',
];

// Sample prompt edits for the Admin screen: each is the repo default plus one tuning line, saved as a version so
// the demo shows version history. scripts/demo-seed.js builds them from the current defaults.
export const PROMPT_EDITS = [
  {
    name: 'score',
    note: 'Weigh healthcare and regulated industries higher',
    append: '\n\nWeigh experience in healthcare and other regulated industries (HIPAA, SOC 2, lab accreditation) as a strength when the posting is in one; do not penalize its absence elsewhere.',
  },
  {
    name: 'cover-letter',
    note: 'Name one measurable result in the first paragraph',
    append: ' Put one measurable result (a team size, a time saved, a percentage) in the first paragraph.',
  },
];

// Finished runs for the Activity tab, replayed when the demo server starts (server/app.js). The output follows the
// shape of a real run's: step lines, then job titles and counts, never email content.
const pipelineStep = (n, name) => ({ step: `[pipeline] Step ${n}/5: ${name}` });
export const SAMPLE_TASKS = [
  {
    kind: 'pipeline',
    meta: { by: 'schedule' },
    output: [
      pipelineStep(1, 'discover'),
      { text: 'LinkedIn: 38 postings, 9 new' },
      { text: 'Himalayas: 21 postings, 4 new' },
      { text: 'Google Jobs: 30 postings, 6 new' },
      { text: 'RemoteOK: 12 postings, 1 new' },
      { text: 'Fractional Jobs: 8 postings, 2 new' },
      { text: 'Details: 20 fetched from the source, 1 rendered in the browser, 1 needs a pasted description' },
      pipelineStep(2, 'score'),
      { text: 'Scoring 21 postings with claude-sonnet-5-5' },
      { text: '9  Director of Engineering, Interoperability at Yarrow Health Data (promoted)' },
      { text: '8  Sr. Director, Clinical Systems at Halcyon Imaging (promoted)' },
      { text: '6  Director of Engineering at Harborline Logistics' },
      { text: '5  VP Engineering at Quillstone Software' },
      { text: '4  Director, Software Engineering at Ridgeview Robotics (onsite)' },
      { text: '16 more scored below 7' },
      { text: 'Scored 21: 2 promoted, cost $0.44' },
      pipelineStep(3, 'hunt'),
      { text: 'Cover letter and resume tweaks: Director of Engineering, Interoperability at Yarrow Health Data' },
      { text: 'Cover letter and resume tweaks: Sr. Director, Clinical Systems at Halcyon Imaging' },
      { level: 'warn', text: 'Letter for Halcyon Imaging is 412 words, over the 400 word limit; flagged for review' },
      { text: 'Wrote 2 letters and 2 sets of tweaks, cost $0.18' },
      pipelineStep(4, 'archive'),
      { text: 'Archived 5 jobs older than 30 days that were never acted on' },
      pipelineStep(5, 'report'),
      { text: 'Sent "Job Agent: 2 new matches, 1 offer to decide" to the candidate' },
    ],
    result: { discovered: 22, scored: 21, promoted: 2, letters: 2, archived: 5 },
  },
  {
    kind: 'inbox',
    meta: { by: 'schedule' },
    output: [
      { step: 'Reading new email since the last check' },
      { text: '14 new messages; 4 from job threads, known contacts, or applicant tracking systems' },
      { step: 'Classifying 4 emails' },
      { text: 'Offer: VP of Engineering at Brightwater Diagnostics (matched by company domain; status Interviewing to Offer)' },
      { text: 'Assessment: SVP, Technology at Arbor Clinical Trials (matched by company domain; reminder added)' },
      { text: 'Application received: Director of Software Engineering at Blue Heron Labs (matched by subject)' },
      { text: 'Recruiter outreach with no company named: held for review' },
      { text: 'Done: 3 linked, 1 to review, cost $0.01' },
    ],
    result: { linked: 3, needsReview: 1 },
  },
  {
    kind: 'score',
    meta: { id: 1 },
    output: [
      { step: 'Re-scoring 1 job' },
      { text: '9  VP of Engineering at Brightwater Diagnostics' },
      { text: 'Done, cost $0.02' },
    ],
  },
];

// The sample candidate's About you, shown read-only on the demo's Settings (server/account-routes.js) in the shape
// help/about-you.md teaches. Invented, like everything here.
export const DEMO_ABOUT_YOU = `## Summary
Engineering leader with 15 years in software and 8 leading teams, mostly in healthcare and other regulated industries. Best at the stage where a product works, customers depend on it, and the platform and team have to grow faster than they were built to.

## Experience highlights
- VP Engineering, a care coordination company (2020 to now): grew the platform team from 6 engineers to 45 with weekly releases; ran SOC 2 Type II and HIPAA as the security lead.
- Director of Engineering, a claims processing company (2016 to 2020): rebuilt the rules engine and cut processing time by 60 percent.
- Engineering Manager, a lab software company (2012 to 2016): led the technology side of an accreditation with no findings; built FHIR integrations with more than 20 health systems.
- Took a venture backed company through a successful acquisition.

## Strengths
- Scaling a platform and a team at the same time, without stopping delivery.
- Turning an executive team's goals into milestones engineers can deliver.
- Distributed teams across the United States, Poland, and Colombia.
- Hands on with TypeScript, Python, and Java.

## What I want next
VP Engineering, Head of Engineering, or CTO at a healthcare or regulated software company of 50 to 500 people. Remote in the US, or hybrid in the Riverton area. Base of $220,000 or more. Open to fractional CTO work at $175 an hour or more for 15 to 25 hours a week.

## Not a fit
- Onsite every day outside the Riverton area.
- Roles that are mainly people management with no platform ownership.
- Crypto and gambling.

## Stories
1. Team growth: 6 to 45 engineers in three years while releases stayed weekly.
2. Rules engine rebuild: phased over two quarters to avoid a big bang cutover.
3. Accreditation: inspection readiness built into the release process.`;
