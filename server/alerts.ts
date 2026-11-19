// Email the owner when something needs attention, since the scheduled jobs run unattended on the server: a scheduled job
// that failed (the pipeline, the inbox check, the backup), and US-only blocking being off because the country database
// is missing. At most one email per kind of problem per day (the day is kept in app_settings as alert:<key>, so a
// restart never resends), and with once, none again until it has recovered. Emails go only to the owner's own address
// (EMAIL_ADDRESS, the same as the run report) and carry job names, dates and error messages only, like the log lines.
// In the app (v3 Phase 7) queue makes each a notify task (server/tasks/notify.ts) with no address: the io worker that runs it
// looks up the owner's address and sends, so the scheduler and the API never hold the Google token for it.
import { claimSetting } from '../db/settings.ts';
import { localDay } from '../tools/dates.ts';
import type { Db } from '../db/engine/types.ts';

type AlertOptions = {
  db: Db;
  /** Sends one email to the owner's address (to). */
  send?: ((email: { to: string; subject: string; text: string }) => Promise<unknown>) | null;
  /** The owner's address. */
  to?: () => string | null;
  /** Instead of send and to: queues the email for a worker that finds the owner's address itself (a notify task). */
  queue?: ((email: { subject: string; text: string }) => Promise<unknown>) | null;
  appUrl?: () => string;
  clock?: () => Date;
  log?: { info?: (text: string) => void; warn?: (text: string) => void };
};

export function createAlerts({ db, send, to = () => null, queue = null, appUrl = () => '', clock = () => new Date(), log = console }: AlertOptions) {
  const key = (k: string) => `alert:${k}`;

  /** Sends one email for this kind of problem, unless one went out today (or, with once, since it last recovered). */
  async function alert(k: string, subject: string, text: string, { once = false } = {}) {
    const today = localDay(clock());
    // The check and the mark are one transaction, so two failures at once send one email.
    if (!(await claimSetting(db, key(k), today, (last) => last !== today && !(once && last)))) return false;
    log.info?.(`[alert] ${k}`);
    const link = appUrl() ? `\n\nOpen ${appUrl()}/#/activity for the details.` : '';
    const email = { subject: `Job Agent: ${subject}`, text: `${text}${link}\n` };
    if (queue) return queue(email).then(() => true, (err: Error) => (log.warn?.(`[alert] ${k}: the email could not be queued (${err.name})`), false));
    const address = to();
    if (!send || !address) return false;
    return send({ ...email, to: address })
      .then(() => true)
      .catch((err: Error) => {
        log.warn?.(`[alert] ${k}: the email could not be sent (${err.name})`);
        return false;
      });
  }

  /** The problem is over: the next one emails again, even the same day. */
  async function recovered(k: string) {
    await db.prepare('DELETE FROM app_settings WHERE key = ?').run(key(k));
  }

  /** The scheduler's report for one run of a job: an email when it failed, recovery when it worked. */
  async function jobResult(name: string, ok: boolean, error?: string | null) {
    if (ok) return await recovered(`job:${name}`);
    const names: Record<string, string> = { pipeline: 'the scheduled pipeline', inbox: 'the scheduled inbox check', backup: 'the nightly backup', 'restore-test': 'the monthly backup restore test' };
    const what = names[name] ?? `the scheduled ${name}`;
    return alert(`job:${name}`, `${what} failed`, `${what[0].toUpperCase()}${what.slice(1)} failed on ${localDay(clock())}: ${error ?? 'no details'}.`);
  }

  return { alert, recovered, jobResult };
}
