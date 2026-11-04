// Internal events, shaped so they can later become messages between services: a type, an ID, a time,
// and IDs only (never email content).
import { randomUUID } from 'node:crypto';

export const EVENT_TYPES = ['email.received', 'email.matched', 'email.needs_review'];

/** An inbox event: IDs only, never email content. */
export interface InboxEvent {
  type: string;
  id: string;
  at: string;
  emailId: string;
  postingId: number | null;
  rule: string | null;
}

export function makeEvent(type: string, { emailId, postingId = null, rule = null }: { emailId?: string; postingId?: number | null; rule?: string | null } = {}, now = new Date()): InboxEvent {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type: ${type}`);
  if (!emailId) throw new Error('An event needs an emailId');
  return { type, id: randomUUID(), at: now.toISOString(), emailId, postingId, rule };
}

/** A minimal in-process emitter. The inbox run counts events; nothing else subscribes yet. */
export function createEmitter() {
  const handlers = new Map<string, Array<(event: InboxEvent) => void>>();
  const counts: Record<string, number> = Object.fromEntries(EVENT_TYPES.map((t) => [t, 0]));
  return {
    on(type: string, fn: (event: InboxEvent) => void) {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
    },
    emit(event: InboxEvent) {
      counts[event.type] = (counts[event.type] as number) + 1;
      for (const fn of handlers.get(event.type) ?? []) fn(event);
    },
    counts: () => ({ ...counts }),
  };
}
