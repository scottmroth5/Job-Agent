// Review emails the inbox could not place confidently. Shows each one (date, sender, subject, type,
// summary, best guess) in this terminal only and asks what to do. Choices are logged and saved as eval cases.
//   npm run inbox:review
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { openJobStore } from '../db/index.js';
import { getInboxAuth } from '../tools/google/auth.js';
import { createGmail } from '../agents/inbox/gmail.js';
import { loadInboxConfig } from '../agents/inbox/config.js';
import { loadKey } from '../agents/inbox/crypto.js';
import { trimBody } from '../agents/inbox/atsParse.js';
import { listOpenApplications } from '../agents/inbox/match.js';
import { listNeedsReview, resolveReview } from '../agents/inbox/review.js';

const TYPE_LABEL = { confirmation: 'Confirmation', rejection: 'Rejection', recruiter_outreach: 'Recruiter outreach', interview_request: 'Interview request', assessment: 'Assessment', offer: 'Offer', follow_up: 'Follow-up', other: 'Other' };

async function pickApplication(rl, db) {
  const open = listOpenApplications(db);
  for (;;) {
    const q = (await rl.question('  Search open applications (company or title), or enter a job number: ')).trim();
    if (/^#?\d+$/.test(q)) return Number(q.replace('#', ''));
    const hits = open.filter((a) => `${a.company} ${a.title}`.toLowerCase().includes(q.toLowerCase())).slice(0, 15);
    if (!hits.length) {
      console.log('  No match. Try another word.');
      continue;
    }
    hits.forEach((a, i) => console.log(`   ${i + 1}. #${a.id} ${a.title} at ${a.company} (${a.status})`));
    const n = Number(await rl.question('  Which one (number, or Enter to search again)? '));
    if (n >= 1 && n <= hits.length) return hits[n - 1].id;
  }
}

async function main() {
  const cfg = loadInboxConfig();
  const store = openJobStore();
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const queue = listNeedsReview(store.db);
    if (!queue.length) {
      console.log('Nothing to review.');
      return;
    }
    const key = loadKey();
    let gmail = null;
    try {
      gmail = createGmail({ auth: getInboxAuth(), onWait: (ms) => console.log(`  (Gmail rate limit; waiting ${ms / 1000} seconds)`) });
    } catch {
      console.log('(Gmail is not signed in, so email bodies will not be stored or saved with eval cases.)');
    }
    console.log(`${queue.length} emails need review.\n`);
    let done = 0;
    for (const [i, e] of queue.entries()) {
      console.log(`${'-'.repeat(70)}\n${i + 1}/${queue.length}  ${e.sent_at.slice(0, 10)}  ${e.sender}`);
      console.log(`  Subject:  ${e.subject ?? ''}`);
      console.log(`  Type:     ${TYPE_LABEL[e.type] ?? e.type} (confidence ${Number(e.confidence ?? 0).toFixed(2)})`);
      console.log(`  Summary:  ${e.summary ?? ''}`);
      if (e.review_reason) console.log(`  Why:      ${e.review_reason}`);
      console.log(`  Guess:    ${e.guess ? `#${e.guess.id} ${e.guess.title} at ${e.guess.company} (${e.guess.status})` : 'none'}`);
      const a = (await rl.question(`  [c]onfirm guess, [r]eassign, [n]ot job related, [o]pportunity, [s]kip, [q]uit: `)).trim().toLowerCase();
      if (a === 'q') break;
      const choice = { c: 'confirm', r: 'reassign', n: 'not_job', o: 'opportunity' }[a];
      if (!choice) continue;
      try {
        const postingId = choice === 'reassign' ? await pickApplication(rl, store.db) : undefined;
        let body = null;
        if (gmail && choice !== 'not_job') {
          const m = await gmail.getMessage(e.gmail_message_id).catch(() => null);
          body = m ? trimBody(m.rawBody, { html: m.bodyIsHtml, max: cfg.bodyChars }) : null;
        }
        const r = resolveReview(store.db, e, choice, { postingId, body, key });
        done += 1;
        if (r.statusChange) console.log(`  Status: ${r.statusChange.from} -> ${r.statusChange.to}`);
        if (r.review) console.log(`  Status not changed: ${r.review}. Change it in the web page if needed.`);
        for (const n of r.notices.filter((n) => !n.startsWith('Needs review'))) console.log(`  ${n}`);
        if (choice === 'opportunity') console.log(`  Created job #${r.postingId} in Discovered.`);
      } catch (err) {
        console.log(`  Not saved: ${err.message}`);
      }
    }
    console.log(`\nResolved ${done} of ${queue.length}.`);
  } finally {
    rl.close();
    store.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
