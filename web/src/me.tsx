// Who is signed in (GET /api/me): components read it with useMe() to show only what this person may do. The server's
// own checks are what protect each action; this only keeps buttons someone cannot use off their screen.
import { createContext, useContext } from 'react';

/** GET /api/me (server/auth.ts): the fields the page reads. */
export interface Me {
  authMode?: string;
  email?: string | null;
  name?: string | null;
  supportEmail?: string | null;
  role?: string | null;
  status?: string;
  owner?: boolean;
  demo?: boolean;
  requestAccessUrl?: string | null;
  analytics?: { key: string; host: string; site?: string | null } | null;
}

export const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);

/** The owner: AUTH_MODE none, or the owner's own Google address. Owner-only actions use the owner's accounts. */
export const isOwner = (me: Me | null | undefined) => Boolean(me?.owner);
export const isAdmin = (me: Me | null | undefined) => me?.role === 'admin';
