// Internal events, shaped so they can later become messages between services: a type, an ID, a time,
// and IDs only (never email content).
import { randomUUID } from 'node:crypto';

export const EVENT_TYPES = ['email.received', 'email.matched', 'email.needs_review'];

export function makeEvent(type, { emailId, postingId = null, rule = null } = {}, now = new Date()) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type: ${type}`);
  if (!emailId) throw new Error('An event needs an emailId');
  return { type, id: randomUUID(), at: now.toISOString(), emailId, postingId, rule };
}

/** A minimal in-process emitter. The inbox run counts events; nothing else subscribes yet. */
export function createEmitter() {
  const handlers = new Map();
  const counts = Object.fromEntries(EVENT_TYPES.map((t) => [t, 0]));
  return {
    on(type, fn) {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
    },
    emit(event) {
      counts[event.type] += 1;
      for (const fn of handlers.get(event.type) ?? []) fn(event);
    },
    counts: () => ({ ...counts }),
  };
}
