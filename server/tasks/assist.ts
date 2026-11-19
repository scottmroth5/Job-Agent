// The job panel's Claude helpers as tasks (v3 Phase 7: moved here from server/prep-routes.ts and
// server/follow-up-routes.ts, whose routes only enqueue them): meeting prep and Find someone to contact.
// Prep text and the people's names stay in the database and the result; task output holds counts only.
import { writeMeetingPrep } from '../../agents/hunt/prep.ts';
import { findContact } from '../../agents/hunt/find-contact.ts';
import type { Claude } from '@scottmroth5/agent-core';
import type { Runtime } from '../runtime.ts';

export function defineAssistTasks({ store, config, services, jobs }: Runtime) {
  jobs.define<{ id: number; input: Parameters<typeof writeMeetingPrep>[0]['input'] }>('meeting-prep', async ({ id, input }, { step, run }) => {
    if (!services.claude) throw new Error('AI is not available here.');
    const r = await writeMeetingPrep({
      store,
      config,
      claude: services.claude as Claude,
      knowledge: await services.knowledge(),
      drive: services.drive,
      run: run as NonNullable<typeof run>, // traced: define's default
      postingId: id,
      input,
      onStep: step,
    });
    step(r.docUrl ? 'Prep ready and saved as a Google Doc' : r.docError ? 'Prep ready (the Google Doc could not be made)' : 'Prep ready');
    return { prepId: r.id, docUrl: r.docUrl, costUsd: r.costUsd, webSearches: r.webSearches };
  });

  jobs.define<{ id: number }>('find-contact', async ({ id }, { step, run }) => {
    if (!services.claude) throw new Error('AI is not available here.');
    const r = await findContact({ store, config, claude: services.claude as Claude, knowledge: await services.knowledge(), run: run as NonNullable<typeof run>, postingId: id, onStep: step });
    step('Saved as a note on the job');
    return r;
  });
}
