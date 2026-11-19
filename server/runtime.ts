// What the API and the workers share (v3 Phase 7): the user-aware settings and services every route and task handler
// reads, and the task queue. buildApp makes one for its routes; a worker process (apps/worker.ts) makes one for its
// task handlers (server/tasks), so a handler runs the same way in the one-process app and in a worker of its own.
import { OWNER_ID } from '../db/users.ts';
import { currentUserId } from '../db/scope.ts';
import { backgroundFor, userConfigView } from '../agents/user-config.ts';
import { createJobs } from './jobs.ts';
import type { JobStore } from '../db/index.ts';
import type { UserConfig } from '../agents/user-config.ts';
import type { AppServices } from './app.ts';
import type { RouteServices } from './types.ts';

export function createRuntime({ store, config, services: given }: { store: JobStore; config: UserConfig; services: AppServices }) {
  // Each user's own settings, background, and documents (agents/user-config.ts): routes and handlers keep using config
  // and services, which answer for whoever the request or task runs as. The owner's are the settings file and Drive.
  const ownerConfig = config;
  const view = config ? userConfigView(config, store.admin) : config;
  const asOwner = () => (currentUserId() ?? OWNER_ID) === OWNER_ID;
  const ownerDrive = given.drive;
  const testKnowledge = given.knowledge; // tests only: a stand-in for the owner's knowledge doc
  const services: AppServices & RouteServices = {
    ...given,
    get drive() {
      return asOwner() ? ownerDrive : null; // others' letters and preps stay in the app (no access to their Drive yet)
    },
    // The knowledge doc from Settings, the current user's. Not the owner means there is a current user.
    knowledge: async () => backgroundFor(store.admin, asOwner() ? OWNER_ID : (currentUserId() as number), { fallback: testKnowledge ?? null }),
  };
  const jobs = createJobs({ store, ownerConfig, createBrowser: services.createBrowser ?? null, log: services.log ?? console, queueOptions: services.queueOptions });
  return { store, ownerConfig, config: view, services, jobs };
}

export type Runtime = ReturnType<typeof createRuntime>;
