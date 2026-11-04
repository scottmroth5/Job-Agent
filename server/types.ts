// Types shared by the server's route modules (v3 Phase 2). Type-only: nothing here runs.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Claude, Run } from '@scottmroth5/agent-core';
import type { DriveClient } from '../tools/google/drive.ts';
import type { PageRenderer } from '../agents/discovery/types.ts';
import type { createTaskRunner } from './tasks.js';
import type { createNotices } from './notices.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The user the request runs as (server/app.js decides it in onRequest); unset with no sign-in (AUTH_MODE=none). */
    uid?: number;
  }
}

export type { FastifyReply, FastifyRequest };

/** The Fastify app the routes register on (server/app.js buildApp). */
export type App = FastifyInstance;

/** Route params for /api/.../:id with an integer id. */
export type IdParams = { id: number };

/** What routes use of buildApp's services; each answers for the user the request runs as. */
export interface RouteServices {
  /** The current user's Claude client, or null where AI is off (the demo, a test without one). */
  claude: Claude | null;
  /** The current user's knowledge doc (About you). */
  knowledge: () => Promise<string>;
  /** The owner's Drive; null for anyone else and where Google is off. */
  drive: DriveClient | null;
}

/** The in-memory task runner (server/tasks.js). */
export type Tasks = ReturnType<typeof createTaskRunner>;

/** The account emails (server/notices.js); routes take any of them, and none in tests. */
export type Notices = Partial<ReturnType<typeof createNotices>>;

/** A task's progress step (server/tasks.js). */
export type TaskStep = (message: string, opts?: { log?: boolean }) => void;

/** buildApp's startTask: a traced background task for the current user; returns its id. */
export type StartTask = (kind: string, meta: Record<string, unknown>, fn: (step: TaskStep, ctx: { run: Run; browser: PageRenderer | null }) => Promise<unknown>) => string;
