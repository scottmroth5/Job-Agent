// notify: an alert email to the owner (server/alerts.ts), as an io task (v3 Phase 7). The scheduler and the API queue it
// with the subject and text only; this handler, in the io worker, looks up the owner's address and sends. Alerts carry
// job names, dates and error messages, never job data, and go only to the owner (EMAIL_ADDRESS).
import { OWNER_ID } from '../../db/users.ts';
import { createAlerts } from '../alerts.ts';
import type { Db } from '../../db/engine/types.ts';
import type { Jobs } from '../jobs.ts';

/** How the io worker emails the owner: their address, and a sender (the owner's Google sign-in). */
export type OwnerMail = { to: () => string | null; send: (email: { to: string; subject: string; text: string }) => Promise<unknown> };
type Note = { subject: string; text: string };

export function defineNotifyTasks({ jobs, mail }: { jobs: Jobs; mail: OwnerMail }) {
  jobs.define<Note>('notify', async ({ subject, text }, { step }) => {
    const to = mail.to();
    if (!to) {
      step('No owner address is set (EMAIL_ADDRESS); nothing sent');
      return { sent: false };
    }
    await mail.send({ to, subject, text });
    step('Emailed the owner');
    return { sent: true };
  }, { trace: false });
}

/** The app's alerts: the once-a-day check where the problem is seen, the email as a notify task for an io worker. */
export function queuedAlerts({ db, jobs, appUrl, log }: { db: Db; jobs: Jobs; appUrl?: () => string; log?: { info?: (text: string) => void; warn?: (text: string) => void } }) {
  return createAlerts({
    db,
    queue: async ({ subject, text }) => jobs.start('notify', { subject, text } satisfies Note, { by: 'schedule', userId: OWNER_ID }),
    appUrl,
    log,
  });
}
