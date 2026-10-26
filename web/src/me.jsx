// Who is signed in (GET /api/me): components read it with useMe() to show only what this person may do. The server's
// own checks are what protect each action; this only keeps buttons someone cannot use off their screen.
import { createContext, useContext } from 'react';

export const MeContext = createContext(null);
export const useMe = () => useContext(MeContext);

/** The owner: AUTH_MODE none, or the owner's own Google address. Owner-only actions use the owner's accounts. */
export const isOwner = (me) => Boolean(me?.owner);
export const isAdmin = (me) => me?.role === 'admin';
