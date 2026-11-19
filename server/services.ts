// The outside services a process runs with (moved here from server/main.ts in v3 Phase 7, so the API and every worker
// build them the same way): Claude, HTTP, Drive, the browser, child scripts, Gmail, account emails, and the owner's alert
// sender. The demo gets none of them: no Google sign-in, Claude client, browser, or schedule, so a visitor can never
// reach a real account or spend money, even through a route the read-only check missed.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createJobClaude } from '../tools/claude.ts';
import { createHttp } from '../tools/http.ts';
import { createBrowser } from '../tools/browser.ts';
import { getGoogleAuth, getInboxAuth } from '../tools/google/auth.ts';
import { createGmail } from '../agents/inbox/gmail.ts';
import { loadInboxConfig } from '../agents/inbox/config.ts';
import { loadKey } from '../agents/inbox/crypto.ts';
import { createDriveClient } from '../tools/google/drive.ts';
import { ROOT } from '../tools/paths.ts';
import { schedulesFromEnv } from '../tools/scheduler.ts';
import { createNotices } from './notices.ts';
import { pipelineScriptArgs } from './tasks/pipeline.ts';
import { claimSetting } from '../db/settings.ts';
import { getUser, OWNER_ID } from '../db/users.ts';
import { sendEmail } from '../tools/google/gmail.ts';
import type { Email } from '../tools/google/gmail.ts';
import type { JobStore } from '../db/index.ts';
import type { AppServices, RunScript } from './app.ts';
import type { AuthSettings } from './auth.ts';
import type { Notices } from './types.ts';
import type { BudgetExceededError } from '../tools/budget.ts';
import type { User } from '../db/users.ts';

/**
 * Runs a script as its own process: the same scripts as npm run pipeline and npm run backup, so a long run never
 * blocks the process that started it. A task's signal (its timeout, or its worker stopping) stops the child too.
 */
export const runScript: RunScript = ({ script, args = [], onLine, onError = () => {}, signal }) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', script, ...args], { cwd: ROOT, env: process.env, windowsHide: true });
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    };
    if (signal?.aborted) stop();
    signal?.addEventListener('abort', stop, { once: true });
    let lastError: string | null = null;
    createInterface({ input: child.stdout }).on('line', onLine);
    createInterface({ input: child.stderr }).on('line', (l) => {
      if (l.trim()) lastError = l.trim().slice(0, 300);
      onError(l);
    });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', stop);
      resolve({ code: 1, lastError: err.message });
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      resolve({ code: code ?? 1, lastError: signal?.aborted ? (lastError ?? 'Stopped.') : lastError });
    });
  });

/**
 * The services a process runs with: the real ones, or the demo's (none). Google sign-in is required (a missing one stops
 * the process at start), except where needsGoogle is false: a worker for the browser pool alone (v3 Phase 7), which is
 * given no Google settings. There Drive is null and sending an email fails visibly; neither is used by its tasks.
 */
export function buildServices({ store, authConfig, demo, needsGoogle = true }: { store: JobStore; authConfig: Pick<AuthSettings, 'publicUrl'>; demo: boolean; needsGoogle?: boolean }): AppServices {
  if (demo) return demoServices();
  const auth = needsGoogle ? getGoogleAuth() : null;
  const send = (email: Email) => {
    if (!auth) throw new Error('Google is not set up for this service, so it sends no email.');
    return sendEmail(auth, email);
  };
  // Account emails (server/notices.ts): to the owner, or to a person about their own account; never anyone else.
  const notices: Notices = createNotices({ send, owner: () => process.env.EMAIL_ADDRESS || null, appUrl: () => authConfig.publicUrl ?? '' });
  // A user on the owner's key who uses up their allowance, and the owner, hear about it once a month.
  const onCapReached = async (uid: number, error: Error) => {
    const err = error as BudgetExceededError; // the cap's refusal (tools/claude.ts)
    if (uid === OWNER_ID || err.scope !== 'user') return;
    const key = `allowance-notice:${uid}`;
    // The check and the mark are one transaction, so two refusals at once send one notice.
    if (!(await claimSetting(store.admin, key, err.status.month, (last) => last !== err.status.month))) return;
    await notices.allowanceReached?.((await getUser(store.admin, uid)) as User, err.status); // a user on the owner's key has a row
  };
  return {
    claude: createJobClaude(store.db, { onCapReached }),
    notices,
    http: createHttp(),
    drive: auth ? createDriveClient(auth) : null,
    createBrowser: () => createBrowser(),
    runScript,
    // Each user's own pipeline: the script runs as them (--user), with their settings, background, and Claude key.
    // args are a step (--only, --since) and the step flags (agents/automation.ts skipArgs); nothing else reaches the command line.
    runPipeline: ({ user, args = [], ...opts }) => runScript({ ...opts, script: 'scripts/pipeline.js', args: pipelineScriptArgs(user, args) }),
    schedules: appSchedules(store),
    inbox: {
      ready: () => Boolean(process.env.GMAIL_REFRESH_TOKEN && process.env.EMAIL_ENC_KEY),
      gmail: (opts = {}) => createGmail({ auth: getInboxAuth(), ...opts }),
      key: () => loadKey(),
      cfg: loadInboxConfig(),
    },
    // Failure emails (server/alerts.ts, sent by a notify task), only ever to the owner's own address, like the run report.
    ownerMail: { to: () => process.env.EMAIL_ADDRESS || null, send },
    appUrl: () => authConfig.publicUrl ?? '',
  };
}

/**
 * The .env schedules. On PostgreSQL the backup container runs the backup and the restore test
 * (scripts/backup-service.js); the app's image has no pg_dump, so its scheduler leaves them out.
 */
export function appSchedules(store: Pick<JobStore, 'engine'>, env: NodeJS.ProcessEnv = process.env) {
  return schedulesFromEnv(env).filter((j) => store.engine !== 'postgres' || (j.name !== 'backup' && j.name !== 'restore-test'));
}

const demoOff = () => {
  throw Object.assign(new Error('Turned off in the demo.'), { statusCode: 403 });
};
function demoServices(): AppServices {
  return {
    claude: null,
    http: null,
    drive: null,
    createBrowser: null,
    runScript: async () => ({ code: 1, lastError: 'Turned off in the demo.' }),
    runPipeline: async () => ({ code: 1, lastError: 'Turned off in the demo.' }),
    schedules: [],
    inbox: { ready: () => false, gmail: demoOff, key: demoOff, cfg: loadInboxConfig() },
  };
}
