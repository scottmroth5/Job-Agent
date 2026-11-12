// Each user's automatic runs (Settings > Automatic runs): whether anything runs on its own at all, when their pipeline
// runs, which of its Claude steps a scheduled run does, and, for the owner, when the inbox is checked. Off means manual
// runs only: the scheduler starts nothing for them, and every button still works.
// Until a user saves, the settings come from what ran before this screen existed: the owner's SCHEDULE_PIPELINE and
// SCHEDULE_INBOX from .env, and, for anyone else, the old "Run my pipeline on the app's schedule too" checkbox on the
// app's default pipeline schedule (SCHEDULE_PIPELINE). Times are in the app's time zone (TZ), like the scheduler.
import { OWNER_ID } from '../db/users.ts';
import { parseSchedule } from '../server/scheduler.ts';
import type { Db } from '../tools/types.ts';

/** What a scheduled pipeline run does with Claude: score new jobs, and write letters and resume tweaks. */
export type AutomationSteps = { score: boolean; letters: boolean };
/** The owner's inbox checks: after each scheduled pipeline run, and at its own times (a spec), or neither. */
export type InboxAutomation = { afterPipeline: boolean; schedule: string | null };
export type Automation = {
  on: boolean;
  pipeline: string | null;
  steps: AutomationSteps;
  /** The owner only (the inbox is the owner's own Gmail); null for everyone else. */
  inbox: InboxAutomation | null;
  /** False until the user saves on Settings: the values above are the defaults. */
  saved: boolean;
};
/** The app's default schedules, from .env. */
export type AutomationDefaults = { pipeline: string | null; inbox: string | null };

const KEY = 'automation';
const LEGACY_KEY = 'schedule.pipeline';
const MAX_SPEC = 200;
const ALL_STEPS: AutomationSteps = { score: true, letters: true };

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/** The app's default schedules from the environment (blank is none). */
export const automationDefaults = (env: Record<string, string | undefined> = process.env): AutomationDefaults => ({
  pipeline: env.SCHEDULE_PIPELINE?.trim() || null,
  inbox: env.SCHEDULE_INBOX?.trim() || null,
});

const readSetting = async (db: Db, uid: number, key: string) =>
  (await db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').pluck().get(uid, key) as string | null | undefined) ?? null;

/** A schedule spec that parses, or null for none; a bad one throws a 400 that says what is wrong. */
function spec(v: unknown, what: string): string | null {
  if (v == null || (typeof v === 'string' && !v.trim())) return null;
  if (typeof v !== 'string' || v.length > MAX_SPEC) throw bad(`The ${what} schedule is not valid.`);
  try {
    return parseSchedule(v).spec;
  } catch (err) {
    throw bad(`The ${what} schedule: ${(err as Error).message}`);
  }
}

/** A saved or default spec that no longer parses is treated as none, so one bad value never stops the scheduler. */
const safeSpec = (v: unknown) => {
  try {
    return spec(v, 'saved');
  } catch {
    return null;
  }
};

/** A user's automatic runs: what they saved, else the defaults above. */
export async function automationFor(db: Db, uid: number, defaults: AutomationDefaults): Promise<Automation> {
  const owner = uid === OWNER_ID;
  const raw = await readSetting(db, uid, KEY);
  if (raw) {
    try {
      const s = JSON.parse(raw) as Record<string, unknown>;
      const steps = (s.steps ?? {}) as Record<string, unknown>;
      const inbox = (s.inbox ?? {}) as Record<string, unknown>;
      return {
        on: s.on === true,
        pipeline: safeSpec(s.pipeline),
        steps: { score: steps.score !== false, letters: steps.letters !== false },
        inbox: owner ? { afterPipeline: inbox.afterPipeline !== false, schedule: safeSpec(inbox.schedule) } : null,
        saved: true,
      };
    } catch {
      // An unreadable value falls through to the defaults.
    }
  }
  const pipeline = safeSpec(defaults.pipeline);
  if (owner) {
    const inbox = safeSpec(defaults.inbox);
    return { on: Boolean(pipeline || inbox), pipeline, steps: { ...ALL_STEPS }, inbox: { afterPipeline: true, schedule: inbox }, saved: false };
  }
  return { on: (await readSetting(db, uid, LEGACY_KEY)) === 'on', pipeline, steps: { ...ALL_STEPS }, inbox: null, saved: false };
}

/**
 * Checks and saves a user's automatic runs. Only the owner may set the inbox. Returns what was saved. Throws a 400
 * that says what is wrong, saving nothing.
 */
export async function saveAutomation(db: Db, uid: number, input: Record<string, unknown>): Promise<Automation> {
  const owner = uid === OWNER_ID;
  if (!owner && input.inbox != null) throw bad('Only the owner has an inbox check for now.');
  const steps = (input.steps ?? {}) as Record<string, unknown>;
  const inbox = (input.inbox ?? {}) as Record<string, unknown>;
  const value: Automation = {
    on: input.on === true,
    pipeline: spec(input.pipeline, 'pipeline'),
    steps: { score: steps.score !== false, letters: steps.letters !== false },
    inbox: owner ? { afterPipeline: inbox.afterPipeline === true, schedule: spec(inbox.schedule, 'inbox') } : null,
    saved: true,
  };
  const { saved, ...stored } = value;
  await db
    .prepare(`INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(uid, KEY, JSON.stringify(stored), new Date().toISOString());
  return value;
}

/** The pipeline flags for a scheduled run that leaves out the Claude steps a user turned off. */
export const skipArgs = (steps: AutomationSteps) => [...(steps.score ? [] : ['--no-score']), ...(steps.letters ? [] : ['--no-letters'])];

/** Every active account with automatic runs on, and their settings (the scheduler's list; db is unscoped). */
export async function automatedUsers(db: Db, defaults: AutomationDefaults): Promise<Array<{ uid: number; automation: Automation }>> {
  const ids = (await db.prepare("SELECT id FROM users WHERE status = 'active' ORDER BY id").pluck().all()) as number[];
  const out: Array<{ uid: number; automation: Automation }> = [];
  for (const uid of ids) {
    const automation = await automationFor(db, uid, defaults);
    if (automation.on) out.push({ uid, automation });
  }
  return out;
}
