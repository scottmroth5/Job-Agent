// The public demo's sample job search: a fictional candidate and fictional companies. Every name, place, and
// figure here is invented. Dates are days before the seed runs, so the demo always looks current.
// scripts/demo-seed.js turns this into a database; nothing here is ever read by the real app.

export const CANDIDATE = {
  name: 'Jordan Avery',
  signoffName: 'Jordan Avery',
  contactLine: 'Riverton, ST | jordan.avery@example.com | 555-0142',
  linkedin: 'linkedin.com/in/example-jordan-avery',
};

// Who the demo is "signed in" as: the header shows it as production shows a signed-in address (the part before the @).
export const DEMO_EMAIL = 'jordan.avery@example.com';

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

// The sample candidate's knowledge doc, shown read-only on the demo's Settings (server/account-routes.js): a full worked
// example of the seven sections (agents/knowledge-sections.js) that Help teaches. Invented, like everything here.
export const DEMO_ABOUT_YOU = `## 1. Summary
Engineering leader with 15 years in software and 8 leading teams, mostly in healthcare and other regulated industries. I am at my best when a product works, customers depend on it, and the platform and the team now have to grow faster than they were built to. Known for scaling teams without slowing releases, and for passing audits on the first try.

## 2. Experience
**VP Engineering, a care coordination company (2020 to now)**
- Grew the platform team from 6 engineers to 45 across the United States, Poland, and Colombia; releases stayed weekly.
- Security lead for SOC 2 Type II and HIPAA: two audits, no exceptions.
- Led engineering through a successful acquisition, including the integration plan and keeping the team together.
- Budget of $9M; report to the CEO.

**Director of Engineering, a claims processing company (2016 to 2020)**
- Rebuilt the claims rules engine in phases over two quarters; processing time down 60 percent, no big bang cutover.
- Built FHIR integrations with more than 20 health systems.

**Engineering Manager, a lab software company (2012 to 2016)**
- Managed a team of eight; led the technology side of a lab accreditation that closed with no findings.

## 3. Strengths
- Scaling a platform and a team at the same time: 6 to 45 engineers with weekly releases.
- Regulated software: HIPAA, SOC 2, lab accreditation; I build compliance into the release process instead of bolting it on.
- Turning an executive team's goals into milestones engineers can deliver, and saying no clearly.
- Distributed teams across three countries and time zones.
- Hands on when it counts: TypeScript, Python, and Java.

## 4. Stories
1. **Team growth:** joined with 6 engineers and a platform that fell over on Mondays. Hired managers first, split the team by customer journey, and kept weekly releases throughout; 45 engineers three years later.
2. **Rules engine rebuild:** claims took days. Ran the old and new engines side by side, moved one claim type at a time, and cut processing time 60 percent with no outage.
3. **Accreditation:** inspection in six weeks with gaps in traceability. Built audit trails into the deployment pipeline; closed with no findings.

## 5. Job Targets
- **Roles:** VP Engineering, Head of Engineering, or CTO; Director of Engineering at a larger company.
- **Industries:** healthcare and other regulated software first; fintech and edtech are fine.
- **Company:** 50 to 500 people, Series B or later, or a private company with a working product.
- **Place:** remote in the US, or hybrid in the Riverton area (Riverton, Lakeside, Millbrook). No relocation.
- **Pay:** base of $220,000 or more for full time. Fractional CTO work at $175 an hour or more, 15 to 25 hours a week.
- **Not a fit:** onsite every day outside the Riverton area; pure people management with no platform ownership; crypto and gambling; seed-stage companies before product-market fit.
- **Positioning:** for executive roles (CTO, VP, Head of, Director), lead with scaling the team and platform, the acquisition, and audits passed. For hands-on manager roles, lead with the rules engine rebuild and hiring and coaching managers.

## 6. Cover Letter Rules
- Plain, specific, and warm; under 300 words. Open with what the company does and why its stage fits my experience.
- One measurable result in the first paragraph.
- Never use "I am confident", "passionate", "rockstar", or "synergy". No dashes; use commas or periods.
- Never claim experience not listed here, and never name past employers; describe them by what they do.
- Mention distributed teams only when the posting does.

## 7. Other
- BS Computer Science, Example State University.
- Certified Scrum Professional. Conversational Spanish.
- Mentor for first-time engineering managers in a local meetup.`;

// The demo's Find someone to contact: a canned answer in the real one's shape, built from the sample job. The people are
// invented and their links are example.com pages; no model is called and nothing is saved.
const slug = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-');
export function demoContactResult({ company, title, appliedOn = null }) {
  const site = `https://${slug(company) || 'example'}.example.com`;
  const reportsTo = /\b(vp|vice president|head|svp|chief|cto)\b/i.test(title) ? 'Chief Technology Officer' : 'VP of Engineering';
  return `## Who to contact at ${company}

### People to contact

- **Morgan Ellis**, ${reportsTo}: most likely the hiring manager, since the ${title} role reports to this seat. Evidence: the leadership page lists Morgan in this role ([${site}/about/leadership](${site}/about/leadership)). Sure: medium.
- **Riley Chen**, Senior Technical Recruiter: posted engineering leadership roles this quarter. Evidence: the careers page names Riley as the recruiting contact ([${site}/careers](${site}/careers)). Sure: high.
- No email addresses were found. The company's public press contacts use first.last@, so morgan.ellis@ is a guess to confirm, not a fact.

### LinkedIn connection note

> Hi Morgan, I applied for the ${title} role${appliedOn ? ` on ${appliedOn}` : ''}. I grew a health tech platform team from 6 to 45 engineers while releases stayed weekly. Would you be open to a 15 minute conversation?

### Short email

**Subject:** ${title} application, Jordan Avery

Hi Morgan, I applied for the ${title} role and wanted to reach you directly. At my last company I grew the platform team from 6 to 45 engineers and led the technology side of an accreditation with no findings, which looks close to what ${company} is building toward. If it would help, I would welcome 15 minutes to hear what matters most in the first year. Thank you, Jordan

### Next

Send one note; if there is no reply in a week, one short nudge, then let it go.`;
}

// Job sites the sample candidate skips (Settings > Job sites to skip), each with a note: a real paywalled job board as
// the example, and an invented one.
export const DEMO_SKIPPED_SITES = [
  { site: 'execthread.com', note: 'Paywall: you pay a membership to see the jobs. Not worth it; find the job on the employer site instead.', daysAgo: 30 },
  { site: 'paytoapply-jobs.example', note: 'Charges a fee to apply.', daysAgo: 12 },
];

// The sample candidate's resumes (Settings > Resumes), stored as text files. Letters and tweaks for VP, Head, CTO, and
// Director titles were "written from" the executive one; the rest from the default. Invented, like everything here.
export const DEMO_RESUMES = [
  {
    label: 'Executive',
    titles: 'VP, Vice President, Head of, CTO, Chief, Director',
    filename: 'Jordan Avery - Executive.txt',
    text: `Jordan Avery
Riverton, ST | jordan.avery@example.com | 555-0142 | linkedin.com/in/example-jordan-avery

ENGINEERING EXECUTIVE
Engineering leader with 15 years in software and 8 leading teams in healthcare and other regulated industries. I scale platforms and the teams that build them through fast growth, keep releases steady while doing it, and build compliance into how engineering works instead of bolting it on. Comfortable reporting to a CEO and board, and hands on when it counts.

CORE STRENGTHS
- Scaling organizations: 6 to 45 engineers, managers hired and grown from within
- Regulated software: HIPAA, SOC 2 Type II, lab accreditation, FHIR interoperability
- Platform modernization without big bang cutovers
- Distributed teams across the United States, Poland, and Colombia
- Executive communication: board updates, budgets, and roadmap tradeoffs

EXPERIENCE
VP of Engineering, a care coordination company, Riverton, ST (2020 to present)
Series B to acquisition; 180 employees; platform used by 300 clinics.
- Grew the engineering organization from 6 engineers to 45 in three years across five product teams while keeping weekly releases.
- Hired and coached six engineering managers, four of them first-time managers promoted from within; engineering attrition under 8% a year.
- Security lead for SOC 2 Type II and HIPAA: built the controls into the deployment pipeline and passed two audits with no exceptions.
- Led engineering through the company's acquisition: technical due diligence, the integration plan, and a team retention plan; no regretted departures in the first year.
- Own a $9M budget and report to the CEO; present engineering plans and risks to the board each quarter.
- Moved hosting to a managed cloud setup with infrastructure as code; cloud cost per active clinic down 35%.

Director of Engineering, a claims processing company, Lakeside, ST (2016 to 2020)
Processed 40 million health insurance claims a year for regional payers.
- Rebuilt the claims rules engine in phases over two quarters, running the old and new engines side by side; processing time down 60% with no outage.
- Built FHIR integrations with more than 20 health systems, cutting onboarding for a new partner from 4 months to 6 weeks.
- Grew the team from 12 to 28 engineers across two countries and introduced on-call and incident reviews; major incidents down 70%.
- Partnered with product and compliance to ship a prior authorization product that reached $6M in annual revenue in its second year.

Engineering Manager, a lab software company, Millbrook, ST (2012 to 2016)
- Managed a team of eight building the lab information system used by 60 clinical labs.
- Led the technology side of a CAP lab accreditation: audit trails, validation, and traceability; closed with no findings.
- Introduced automated testing and continuous integration; release cycle from quarterly to every two weeks.

Senior Software Engineer, a health analytics startup, Riverton, ST (2009 to 2012)
- Built the data pipeline and reporting product for the company's first ten hospital customers.

EDUCATION AND CERTIFICATIONS
BS Computer Science, Example State University
Certified Scrum Professional

ADDITIONAL
- Mentor for first-time engineering managers through a local technology meetup
- Conversational Spanish`,
  },
  {
    label: 'Engineering manager',
    titles: 'Engineering Manager, Manager, Team Lead',
    filename: 'Jordan Avery - Engineering Manager.txt',
    text: `Jordan Avery
Riverton, ST | jordan.avery@example.com | 555-0142 | linkedin.com/in/example-jordan-avery

SENIOR ENGINEERING MANAGER
Hands-on engineering manager who builds healthy, high-output teams in regulated software. I hire well, coach managers and senior engineers, keep delivery predictable, and still read the code: TypeScript, Python, and Java, comfortable in any stack.

SKILLS
- People: hiring loops, career ladders, coaching, performance reviews, growing first-time managers
- Delivery: roadmap planning, estimation, weekly releases, on-call and incident reviews
- Technical: TypeScript, Python, Java, PostgreSQL, event-driven services, AWS, Terraform, CI/CD
- Domain: HIPAA, SOC 2, FHIR and HL7 integrations, lab systems, claims processing

EXPERIENCE
VP of Engineering, a care coordination company, Riverton, ST (2020 to present)
- Managed managers and senior engineers across three time zones; coached four first-time managers into the role.
- Wrote the hiring loop and engineering career ladder used to grow the team from 6 to 45 engineers.
- Kept weekly releases through three years of growth by investing in automated tests, feature flags, and small changes.
- Ran incident reviews personally for the first year; turned them into a blameless practice the managers now own.
- Built the SOC 2 and HIPAA controls into the deployment pipeline with the security engineers; two clean audits.

Director of Engineering, a claims processing company, Lakeside, ST (2016 to 2020)
- Ran the rules engine rebuild day to day: design reviews, a side-by-side rollout one claim type at a time, and on-call health; processing time down 60%.
- Led two teams building FHIR integrations with more than 20 health systems; partner onboarding from 4 months to 6 weeks.
- Introduced on-call rotations, runbooks, and incident reviews; major incidents down 70%.

Engineering Manager, a lab software company, Millbrook, ST (2012 to 2016)
- Managed a team of eight; owned releases, hiring, and the accreditation work.
- Moved the team from quarterly releases to every two weeks with continuous integration and automated testing.
- Led the technology side of a lab accreditation with no findings.

Senior Software Engineer, a health analytics startup, Riverton, ST (2009 to 2012)
- Designed and built the data pipeline and the first reporting product; on-call for production.

EDUCATION
BS Computer Science, Example State University
Certified Scrum Professional`,
  },
];
