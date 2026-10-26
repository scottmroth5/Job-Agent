// Email the owner when something needs attention, since the scheduled jobs run unattended on the server: a scheduled job
// that failed (the pipeline, the inbox check, the backup), and US-only blocking being off because the country database
// is missing. At most one email per kind of problem per day (the day is kept in app_settings as alert:<key>, so a
// restart never resends), and with once, none again until it has recovered. Emails go only to the owner's own address
// (EMAIL_ADDRESS, the same as the run report) and carry job names, dates and error messages only, like the log lines.
import { getSetting, setSetting } from '../db/settings.js';
import { localDay } from '../tools/dates.js';

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db
 * @param {(email: { to: string, subject: string, text: string }) => Promise<unknown>} [o.send]  sends one email
 * @param {() => string|null} o.to  the owner's address
 * @param {() => string} [o.appUrl]
 * @param {() => Date} [o.clock]
 * @param {{ info?: Function, warn?: Function }} [o.log]
 */
export function createAlerts({ db, send, to, appUrl = () => '', clock = () => new Date(), log = console }) {
  const key = (k) => `alert:${k}`;

  /** Sends one email for this kind of problem, unless one went out today (or, with once, since it last recovered). */
  async function alert(k, subject, text, { once = false } = {}) {
    const today = localDay(clock());
    const last = getSetting(db, key(k));
    if (last === today || (once && last)) return false;
    setSetting(db, key(k), today);
    log.info?.(`[alert] ${k}`);
    const address = to();
    if (!send || !address) return false;
    const link = appUrl() ? `\n\nOpen ${appUrl()}/#/activity for the details.` : '';
    return send({ to: address, subject: `Job Agent: ${subject}`, text: `${text}${link}\n` })
      .then(() => true)
      .catch((err) => {
        log.warn?.(`[alert] ${k}: the email could not be sent (${err.name})`);
        return false;
      });
  }

  /** The problem is over: the next one emails again, even the same day. */
  function recovered(k) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key(k));
  }

  /** The scheduler's report for one run of a job: an email when it failed, recovery when it worked. */
  async function jobResult(name, ok, error) {
    if (ok) return recovered(`job:${name}`);
    const what = { pipeline: 'the scheduled pipeline', inbox: 'the scheduled inbox check', backup: 'the nightly backup', 'restore-test': 'the monthly backup restore test' }[name] ?? `the scheduled ${name}`;
    return alert(`job:${name}`, `${what} failed`, `${what[0].toUpperCase()}${what.slice(1)} failed on ${localDay(clock())}: ${error ?? 'no details'}.`);
  }

  return { alert, recovered, jobResult };
}
