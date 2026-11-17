// Types shared by the server's route modules (v3 Phase 2). Type-only: nothing here runs.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Claude } from '@scottmroth5/agent-core';
import type { DriveClient } from '../tools/google/drive.ts';
import type { createNotices } from './notices.ts';
import type { accountFor } from '../db/users.ts';

/** A signed-in address's account (db/users.ts accountFor). */
export type Account = NonNullable<Awaited<ReturnType<typeof accountFor>>>;

declare module 'fastify' {
  interface FastifyRequest {
    /** The user the request runs as (server/app.ts decides it in onRequest); unset with no sign-in (AUTH_MODE=none). */
    uid?: number;
    /** The signed-in address (AUTH_MODE=google, server/auth.ts). */
    user?: string;
    /** Its account, on every request that gets past the sign-in check (AUTH_MODE=google). */
    account?: Account | null;
    /** The account's role, set with uid (server/app.ts). */
    role?: string;
    /** The user's own time zone for calendar days; null for the owner, who uses the app's (server/app.ts). */
    timeZone?: string | null;
  }
}

export type { FastifyReply, FastifyRequest };

/** The Fastify app the routes register on (server/app.ts buildApp). */
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

/** The account emails (server/notices.ts); routes take any of them, and none in tests. */
export type Notices = Partial<ReturnType<typeof createNotices>>;


