// The encrypted backup and the monthly restore test as tasks (scheduled), the same scripts as npm run backup and
// npm run backup:test, each in its own process. Defined only with runScript, the only way they are scheduled.
import type { Jobs } from '../jobs.ts';
import type { RunScript } from '../app.ts';

export function defineBackupTasks({ jobs, runScript }: { jobs: Jobs; runScript: RunScript }) {
  jobs.define('backup', async (_payload, { step, logger, signal }) => {
    step('Backing up');
    const { code, lastError } = await runScript({ script: 'scripts/backup.js', onLine: (l) => logger.info(l), onError: (l) => logger.error(l), signal });
    if (code !== 0) throw new Error(lastError ? `The backup failed: ${lastError}` : `The backup failed with exit code ${code}.`);
    step('Backup done');
  }, { trace: false });
  jobs.define('restore-test', async (_payload, { step, logger, signal }) => {
    step('Testing the newest backup');
    const { code, lastError } = await runScript({ script: 'scripts/backup-verify.js', onLine: (l) => logger.info(l), onError: (l) => logger.error(l), signal });
    if (code !== 0) throw new Error(lastError ? `The restore test failed: ${lastError}` : `The restore test failed with exit code ${code}.`);
    step('Restore test passed');
  }, { trace: false });
}
