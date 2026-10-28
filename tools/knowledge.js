// The owner's knowledge doc for scripts: the one they keep in Settings (user_settings), like every other user's.
import { backgroundFor } from '../agents/user-config.js';
import { OWNER_ID } from '../db/users.js';

export const MIN_KNOWLEDGE_CHARS = 500;

/** The owner's knowledge doc; throws a message saying to write it under Settings when it is missing or too short. */
export function ownerBackground(store) {
  return backgroundFor(store.raw ?? store.db, OWNER_ID);
}
