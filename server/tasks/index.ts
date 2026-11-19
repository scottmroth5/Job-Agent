// Every task handler in one place (v3 Phase 7): routes only enqueue; a process that runs tasks defines them all here,
// then runs the pools it serves (server/app.ts for the one-process app and its tests, apps/worker.ts for a worker).
// A handler needs only what the runtime gives it (server/runtime.ts), so it runs the same in either.
import { definePostingTasks } from './postings.ts';
import { defineAssistTasks } from './assist.ts';
import { definePipelineTasks } from './pipeline.ts';
import { defineInboxTasks } from './inbox.ts';
import { defineBackupTasks } from './backup.ts';
import { defineNotifyTasks } from './notify.ts';
import type { Runtime } from '../runtime.ts';

export function defineTasks(rt: Runtime) {
  const { store, services, jobs } = rt;
  definePostingTasks(rt);
  defineAssistTasks(rt);
  if (services.runPipeline) definePipelineTasks({ store, jobs, runPipeline: services.runPipeline, followMs: services.queueOptions?.pollMs });
  if (services.inbox) defineInboxTasks({ store, jobs, claude: services.claude, inbox: services.inbox });
  if (services.runScript) defineBackupTasks({ jobs, runScript: services.runScript });
  if (services.ownerMail) defineNotifyTasks({ jobs, mail: services.ownerMail });
}
