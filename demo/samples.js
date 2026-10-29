// The demo's AI answers: canned samples, written to read like what Claude returns for the real prompts, built from the
// sample job and the fictional candidate's knowledge doc (demo/sample-data.js). The web app loads this file only in the
// demo (web/src/api.js) and calls no model, so the demo never spends anything; nothing here is saved. Every person and
// company is invented.
import { CANDIDATE, DEMO_ABOUT_YOU, DEMO_CONFIG, companyBlurb } from './sample-data.js';

const first = (s) => String(s ?? '').trim().split(/\s+/)[0] ?? '';
const cap = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);
const senior = (title) => /\b(cto|chief|vp|vice president|head|svp)\b/i.test(String(title));
const list = (items) => items.filter(Boolean).map((x) => `- ${x}`).join('\n');

/** Meeting prep: the real prompt's ten sections, for the people and meeting the visitor entered. */
export function samplePrep(job, input = {}) {
  const people = (input.attendees ?? []).filter((p) => p.name?.trim());
  const who = people.length ? people : [{ name: 'Morgan Lee', role: senior(job.title) ? 'CEO' : 'VP of Engineering' }];
  const lead = who[0];
  const blurb = companyBlurb(job.company);
  const a = job.analysis ?? {};
  const kind = input.kind || 'Hiring manager';
  const recruiter = /recruiter|search/i.test(kind);
  const strengths = (a.strengths ?? []).slice(0, 3);
  const gaps = (a.watchOuts ?? []).slice(0, 2);
  const names = who.map((p) => [p.name, p.role].filter(Boolean).join(', ')).join('; ');
  return `# Call Prep: ${lead.name}, ${job.company}

*${job.title} · ${kind}${input.format ? ` · ${input.format}` : ''}${input.meetingAt ? ` · ${new Date(input.meetingAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}*

## The Meeting at a Glance
- **Who:** ${names}.
- **What it most likely is:** ${recruiter ? 'a screen for fit, motivation, logistics, and pay before the hiring manager round' : 'the hiring manager conversation: how you would do the job, starting with the first 90 days'}.
- **Your three goals:** show you have scaled a platform and a team at the same time; get them describing the biggest platform pain in their own words; leave with the next step and who is in it.

## Who You Are Talking To
${who
  .map((p) => `- **${p.name}${p.role ? `, ${p.role}` : ''}:** ${p.about?.trim() || `public profile shows about ten years at ${job.company} and earlier operations roles (per the company's leadership page; verify on LinkedIn)`}. Expect them to probe ${recruiter ? 'why now, why this company, and your pay range' : 'how you would sequence the platform work against product deadlines'}.`)
  .join('\n')}
- **Common ground:** regulated software and growing teams across time zones.

## Company Snapshot
- ${cap(blurb)}.
- Privately held and growing; recent news points to new customers faster than the platform was built for (per their press page; confirm the details in the meeting).
- The posting mentions on call load and release quality, which usually means the platform is the bottleneck.

## Your Opening
> "I have spent the last eight years leading engineering in regulated software, most recently growing a care coordination platform team from 6 engineers to 45 while we kept releasing every week. What drew me to ${job.company} is that you are at the stage I like best: the product works, customers depend on it, and the platform and team now have to grow faster than they were built to."

## Fit Against the Role
| What they want | Your evidence |
| --- | --- |
| Scale the team without slowing delivery | 6 to 45 engineers across three countries; releases stayed weekly |
| Modernize the platform safely | Claims rules engine rebuilt in phases, processing time down 60 percent, no outage |
| Compliance built in | SOC 2 Type II and HIPAA, two audits with no exceptions |
${strengths.length ? `| From your fit analysis | ${strengths.join('; ')} |\n` : ''}
## Stories to Have Ready
1. **Team growth.** *Situation:* 6 engineers and a platform that fell over on Mondays. *Approach:* hired managers first, split teams by customer journey. *Result:* 45 engineers in three years, weekly releases throughout.
2. **Rules engine rebuild.** *Situation:* claims took days. *Approach:* ran old and new engines side by side and moved one claim type at a time. *Result:* 60 percent faster, no big bang cutover.
3. **Accreditation.** *Situation:* six weeks to an inspection with traceability gaps. *Approach:* audit trails built into the deployment pipeline. *Result:* closed with no findings.

## Likely Questions and Your Answers
- **"What would your first 90 days look like?"** "Listen for 30 days: customers, the team, and the numbers. Then agree with you on the two or three bets that matter for the year, and ship the first one by day 90 with a before and after."
- **"How do you grow a team without breaking it?"** "Managers before engineers, teams owned by customer journey, and a release cadence we protect while we grow."
- **"Tell me about a time you said no."** "We paused a feature push for one quarter to fix release stability; incidents fell by half and product got their roadmap back faster."
${recruiter ? '- **"What are you looking for in pay?"** "A base of $220,000 or more; I would like to hear the range for the role first."\n' : ''}
## Gaps: Own Them, Then Bridge
${gaps.length ? gaps.map((g) => `- **${g}.** Say it plainly, then bridge to the closest thing you have done and how you would close the gap in the first months.`).join('\n') : '- **Their exact market.** Say it plainly, then bridge: regulated platforms share the same problems, and you learn the domain from customers in the first 30 days.'}

## Questions to Ask
1. What would make this hire a clear success twelve months from now?
2. Where does the platform hurt most today: reliability, speed, or cost?
3. How do product and engineering decide what not to build?
4. Who else would I work with most closely, and what do they need from this role?

## Close and Next Steps
- Close with a one line summary of the fit and ask: "What is the next step, and who would I meet?"
- Send a short thank you within a day that names one thing ${first(lead.name)} said.`;
}

/** The letter for Write resume tweaks and cover letter, or a fresh one for Regenerate (a different opening). */
export function sampleLetter(job, { regenerate = false } = {}) {
  const blurb = companyBlurb(job.company);
  const open = regenerate
    ? `${job.company} is ${blurb}, and it has reached the point every growing platform does: the product has outgrown the systems and the team that built it. That is the problem I have spent the last eight years solving.`
    : `When I read that ${job.company} is ${blurb}, I recognized the stage you are in: the product works, customers depend on it, and the platform and team now have to grow faster than they were built to.`;
  return `${open}

As VP of Engineering at a care coordination company, I grew the platform team from 6 engineers to 45 across three countries while releases stayed weekly, and I was the security lead for SOC 2 Type II and HIPAA audits that closed with no exceptions. Before that, I rebuilt a claims rules engine in phases, cutting processing time by 60 percent with no big bang cutover.

For the ${job.title} role, I would start by listening to customers, the team, and the numbers. In the first 90 days I would set a release and quality baseline and agree with you on the two or three bets that matter most for the year.

I would welcome a conversation about where ${job.company} is headed and how I can help it get there.`;
}

export function sampleTweaks(job) {
  return `Summary: lead with regulated platform scaling and team growth; name ${job.company}'s market in the first line.

1. Move "Grew the platform team from 6 engineers to 45; releases stayed weekly" into the top three bullets.
2. Add the budget and reporting line to the current role ($9M, reports to the CEO).
3. Reword "Rebuilt the claims rules engine" as "Modernized a core platform in phases with no outage" to match the posting's language.
4. Cut the 2012 to 2016 role to two lines to make room.`;
}

/** Re-score: the same analysis from the posting text, as a re-score of an unchanged posting gives. */
export function sampleScore(job) {
  const a = job.analysis ?? {};
  return {
    score: job.score ?? a.score ?? null,
    reason: a.reason ?? 'Strong fit on scope and industry.',
    note: 'Re-scored from the posting text with Sonnet 5.5: the posting has not changed, so the score and reasons are the same.',
  };
}

// Revise with Claude: the change the visitor asked for, made the way Claude makes it, with a note on what changed.
// Paragraphs line by line (no pattern runs over the visitor's text): blank lines separate them.
const paragraphs = (text) => {
  const out = [];
  let cur = [];
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim()) cur.push(line.trim());
    else if (cur.length) (out.push(cur.join(' ')), (cur = []));
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
};
const sentences = (p) => p.match(/[^.!?]+[.!?]+(\s|$)/g)?.map((s) => s.trim()) ?? [p];
export function sampleRevision({ letter, feedback, company, title }) {
  const ask = String(feedback ?? '').toLowerCase();
  let paras = paragraphs(letter);
  const changes = [];
  if (/short|tight|concise|trim|cut|brief/.test(ask)) {
    const before = paras.join(' ').split(/\s+/).length;
    paras = paras.map((p) => sentences(p).slice(0, 2).join(' '));
    // Already two sentences a paragraph: the middle paragraphs keep their strongest one.
    if (paras.join(' ').split(/\s+/).length === before) paras = paras.map((p, i) => (i > 0 && i < paras.length - 1 ? sentences(p)[0] : p));
    changes.push(`Cut it to the strongest sentence or two in each paragraph, from ${before} words to ${paras.join(' ').split(/\s+/).length}`);
  }
  if (/warm|friend|personal|human/.test(ask)) {
    paras[paras.length - 1] = `I would enjoy talking with you about what ${company} needs from this role in the first year, and about how I can help the team get there. Thank you for considering me.`;
    changes.push('Rewrote the close to sound warmer and more personal');
  }
  if (/lead|open|start|first|hook/.test(ask)) {
    paras[0] = `I have spent eight years growing engineering teams and platforms in regulated software, most recently from 6 engineers to 45 with weekly releases, and ${company} looks like exactly the stage where that experience matters.`;
    changes.push('Opened with your strongest measurable result instead of the company description');
  }
  if (/distributed|remote|countr|time zone|global/.test(ask)) {
    paras.splice(Math.min(2, paras.length - 1), 0, 'I have led teams across the United States, Poland, and Colombia, and I know how to keep a distributed team shipping together: clear ownership, written decisions, and overlap hours we protect.');
    changes.push('Added a paragraph on leading distributed teams, from your knowledge doc');
  }
  if (!changes.length) {
    paras[0] = paras[0].replace(/^When I read that /, 'Reading that ').replace(/, I recognized/, ', I recognized right away');
    paras[paras.length - 1] = `I would welcome a conversation about the ${title} role and where ${company} is headed next.`;
    changes.push('Tightened the opening and the close and kept the rest as it was. This demo\'s sample reviser only knows a few requests: "shorter", "warmer", "lead with a result", and "mention distributed teams"; the real one makes whatever change you ask for');
  }
  return { letter: paras.join('\n\n'), changes: `${changes.join('. ')}.`, flags: [], resume: null, sample: true };
}

// Help's Ask: the guide section that best matches the question, quoted the way the real answer cites the guides.
const STOP = new Set(['what', 'when', 'where', 'which', 'with', 'that', 'this', 'there', 'their', 'have', 'does', 'from', 'your', 'about', 'into', 'would', 'should', 'could', 'make', 'only', 'them', 'they', 'will', 'just', 'some', 'more', 'then', 'than', 'each', 'how']);
const words = (s) => String(s ?? '').toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)) ?? [];
export function sampleHelpAnswer(question, guides = []) {
  const ask = new Set(words(question));
  let best = null;
  for (const g of guides) {
    for (const part of String(g.markdown ?? '').split(/\n(?=## )/)) {
      const heading = /^##\s+(.+)$/m.exec(part)?.[1] ?? g.title;
      const hits = words(part).filter((w) => ask.has(w)).length + words(heading).filter((w) => ask.has(w)).length * 3;
      if (!best || hits > best.hits) best = { hits, guide: g.title, heading, text: part.replace(/^##\s+.+\n/, '').trim() };
    }
  }
  if (!best || best.hits === 0) {
    return { answer: 'The guides do not cover that yet. Try Getting started for the overall flow, or ask about a screen by name (Jobs, Settings, Funnel, Inbox).', sample: true };
  }
  const plain = best.text.replace(/\*\*/g, '').replace(/^- /gm, '').split('\n').filter(Boolean).slice(0, 4).join(' ');
  const short = plain.length > 700 ? `${plain.slice(0, plain.lastIndexOf(' ', 700))}…` : plain;
  return { answer: `${short} (From ${best.guide}, "${best.heading}".)`, sample: true };
}

/** Build a draft: the sample candidate's knowledge doc and search, as a draft from a resume and LinkedIn profile. */
export function sampleDraft() {
  const s = DEMO_CONFIG.search;
  return {
    aboutYou: DEMO_ABOUT_YOU,
    candidate: { ...CANDIDATE },
    search: { terms: s.terms, relevantTitleKeywords: s.relevantTitleKeywords, noiseTitleKeywords: s.noiseTitleKeywords, homeLocations: s.homeLocations, fractionalTerms: s.fractionalTerms },
    questions: [
      'What was the budget and headcount at the claims processing company? Section 2 has them for your current role only.',
      'Which cover letter phrases do you never want used? Section 6 lists four; add any others.',
      'Would you consider relocating for a CTO role? Section 5 says no relocation; confirm that holds for every title.',
    ],
    sample: true,
  };
}
