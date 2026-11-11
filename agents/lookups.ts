// The configurable lists (status, stage, track): the one place that knows their values, groups, and roles.
// Jobs store each value's immutable text ID. Behavior comes from the value's group, never from its ID, so
// added values work everywhere the built-in ones do. Values are archived, never deleted: an archived value
// stays valid on the jobs that have it, and drops out of menus and automation targets.

import { BUILT_INS, BUILT_IN_ROLES } from '../db/migrations/009-lookups.ts';
import { connectionKey } from '../db/engine/index.ts';
import type { Db } from '../db/engine/types.ts';
import { insideTransaction } from '../db/engine/sqlite.ts';
import type { LookupRolesRow, LookupValuesRow } from '../db/types.ts';

/** One value of a list, as the app uses it. settings: a track's scorePrompt and terms. */
export interface LookupValue {
  id: string;
  label: string;
  group: string;
  order: number;
  settings: { scorePrompt?: string; terms?: boolean };
  origin: string;
  archived: boolean;
}

type StatusGroup = { rank: number | null; needsAction: boolean; inProgress: boolean; autoArchive: 'age' | 'never' | 'now' };

/** A list value's row as build() reads it (the database's, or a built-in seed's). */
type ValueRow = Pick<LookupValuesRow, 'list' | 'id' | 'label' | 'group_key' | 'sort_order' | 'settings_json' | 'origin' | 'archived_at'>;

export const LISTS = ['status', 'stage', 'track'];

/** Groups per list, in order, with what each one means. */
export const GROUPS: Record<string, Array<{ key: string; label: string; help: string }>> = {
  status: [
    { key: 'evaluate', label: 'To evaluate', help: 'Shows under Needs action; archived after 30 days' },
    { key: 'waiting', label: 'Waiting to hear back', help: 'Shows under In progress; archived after 30 days' },
    { key: 'conversation', label: 'In conversation', help: 'Shows under In progress; never archived automatically' },
    { key: 'decision', label: 'Decision', help: 'Shows under Needs action and In progress; never archived automatically' },
    { key: 'closed', label: 'Closed', help: 'Archived right away; never scored again; not counted as an open copy' },
  ],
  stage: [
    { key: 'found', label: 'Found', help: 'Not yet promoted; scoring promotes 7+ jobs from here' },
    { key: 'active', label: 'Active', help: 'Your working list: letters, the report, and open applications' },
    { key: 'archived', label: 'Archived', help: 'Out of the way; kept for history and duplicate checks' },
  ],
  track: [{ key: 'track', label: 'Track', help: 'Settings choose the scoring prompt and whether pay and hours show' }],
};

// What each status group does. rank orders the inbox's forward-only moves; closed is terminal.
const STATUS_GROUP: Record<string, StatusGroup> = {
  evaluate: { rank: 0, needsAction: true, inProgress: false, autoArchive: 'age' },
  waiting: { rank: 1, needsAction: false, inProgress: true, autoArchive: 'age' },
  conversation: { rank: 2, needsAction: false, inProgress: true, autoArchive: 'never' },
  decision: { rank: 3, needsAction: true, inProgress: true, autoArchive: 'never' },
  closed: { rank: null, needsAction: false, inProgress: false, autoArchive: 'now' },
};

/** Roles a list has, and which group the value holding each role must be in (null: any). */
export const ROLES: Record<string, Record<string, string[] | null>> = {
  status: {
    default: ['evaluate'],
    noResponse: ['closed'],
    // The values the app sets itself (023): the inbox's moves, duplicate copies, and cleanup.
    applied: ['waiting'],
    interview: ['conversation'],
    offer: ['decision'],
    rejected: ['closed'],
    duplicate: ['closed'],
    passed: ['closed'],
  },
  stage: { default: ['found', 'active'], promote: ['active'], archive: ['archived'] },
  track: { default: null },
};
export const ROLE_LABELS: Record<string, string> = {
  default: 'Default for new jobs',
  promote: 'Where 7+ jobs are promoted',
  archive: 'Where archived jobs go',
  noResponse: 'Where stale applications are closed (no reply)',
  applied: 'Where a confirmation email moves a job',
  interview: 'Where an interview request moves a job',
  offer: 'Where an offer email moves a job',
  rejected: 'Where a rejection email moves a job (the funnel counts moves to it as rejections)',
  duplicate: 'Where duplicate copies are closed',
  passed: 'Where cleanup closes jobs you never acted on',
};

// The status roles 023 added, on the built-in values, for the built-in lists below.
const ADDED_ROLES: Array<[list: string, role: string, valueId: string]> = [
  ['status', 'applied', 'applied'],
  ['status', 'interview', 'interviewing'],
  ['status', 'offer', 'offer'],
  ['status', 'rejected', 'rejected'],
  ['status', 'duplicate', 'duplicate'],
  ['status', 'passed', 'passed'],
];

export const SCORE_PROMPTS = ['score', 'score-fractional'];
const ID = /^[a-z][a-z0-9_]{0,39}$/;

// One cache per connection (db/engine connectionKey), however many views of it callers hold; the generation counts
// edits, so a load that an edit overtook is not cached.
const cache = new WeakMap<object, { lookups: Lookups; generation: number }>();
const generations = new WeakMap<object, number>();

function build(rows: ValueRow[], roles: Array<Pick<LookupRolesRow, 'list' | 'role' | 'value_id'>>) {
  const byList: Record<string, LookupValue[]> = Object.fromEntries(LISTS.map((l) => [l, []]));
  for (const r of rows) {
    (byList[r.list] as LookupValue[]).push({
      id: r.id,
      label: r.label,
      group: r.group_key,
      order: r.sort_order,
      settings: r.settings_json ? JSON.parse(r.settings_json) : {},
      origin: r.origin,
      archived: Boolean(r.archived_at),
    });
  }
  const roleMap: Record<string, Record<string, string>> = Object.fromEntries(LISTS.map((l) => [l, {}]));
  for (const r of roles) (roleMap[r.list] as Record<string, string>)[r.role] = r.value_id;
  return makeApi(byList, roleMap);
}

/** The built-in lists (the 009 seeds and 023's roles), for code and tests that run without a database. */
let builtIn: Lookups | null = null;
export function builtInLookups(): Lookups {
  builtIn ??= build(
    BUILT_INS.map(([list, id, label, group, settings], i) => ({ list, id, label, group_key: group, sort_order: (i + 1) * 10, settings_json: settings ? JSON.stringify(settings) : null, origin: 'built_in', archived_at: null })),
    [...BUILT_IN_ROLES, ...ADDED_ROLES].map(([list, role, value_id]) => ({ list, role, value_id })),
  );
  return builtIn;
}

/** Drops the cached lists (call after any edit). */
export function invalidateLookups(db: Db) {
  const key = connectionKey(db);
  generations.set(key, (generations.get(key) ?? 0) + 1);
  cache.delete(key);
}

/**
 * The lists for this database, cached until invalidateLookups(db). Helpers include archived values,
 * because their behavior still applies to the jobs that have them.
 */
export async function lookups(db: Db | null | undefined): Promise<Lookups> {
  if (!db) return builtInLookups();
  // Inside a transaction (an edit's checks) the lists are read fresh and not cached, as they may not be committed.
  const inTx = insideTransaction();
  const key = connectionKey(db);
  const generation = generations.get(key) ?? 0;
  const hit = cache.get(key);
  if (hit && hit.generation === generation && !inTx) return hit.lookups;
  const q = db;
  const built = build(
    (await q.prepare('SELECT * FROM lookup_values ORDER BY list, sort_order, id').all()) as ValueRow[],
    (await q.prepare('SELECT list, role, value_id FROM lookup_roles').all()) as LookupRolesRow[],
  );
  if (!inTx && (generations.get(key) ?? 0) === generation) cache.set(key, { lookups: built, generation });
  return built;
}

function makeApi(byList: Record<string, LookupValue[]>, roles: Record<string, Record<string, string>>) {
  const find = (list: string, id: string | null | undefined) => byList[list]?.find((v) => v.id === id) ?? null;
  const statusIds = (pred: (g: Partial<StatusGroup>) => boolean | undefined) => (byList.status as LookupValue[]).filter((v) => pred(STATUS_GROUP[v.group] ?? {})).map((v) => v.id);
  const api = {
    values: (list: string, { includeArchived = true }: { includeArchived?: boolean } = {}) => (byList[list] as LookupValue[]).filter((v) => includeArchived || !v.archived),
    get: find,
    label: (list: string, id: string) => find(list, id)?.label ?? id,
    groupOf: (list: string, id: string | null | undefined) => find(list, id)?.group ?? null,
    /** IDs in any of the given groups. */
    ids: (list: string, ...groups: string[]) => (byList[list] as LookupValue[]).filter((v) => groups.includes(v.group)).map((v) => v.id),
    role: (list: string, name: string): string | null => roles[list]?.[name] ?? null,
    roles: (list: string): Record<string, string> => ({ ...roles[list] }),
    /** True when the value exists and is not archived (allowed for a new choice). */
    selectable: (list: string, id: string) => Boolean(find(list, id) && !find(list, id)?.archived),
    /** Status behavior. */
    needsAction: () => statusIds((g) => g.needsAction),
    inProgress: () => statusIds((g) => g.inProgress),
    open: () => statusIds((g) => g.inProgress),
    closed: () => statusIds((g) => g.autoArchive === 'now'),
    neverAutoArchived: () => statusIds((g) => g.autoArchive === 'never'),
    /** Forward-only rank of a status: 0..3, or null for a closed (terminal) status. */
    rank: (statusId: string | null | undefined) => STATUS_GROUP[find('status', statusId)?.group as string]?.rank ?? null,
    isClosed: (statusId: string | null | undefined) => find('status', statusId)?.group === 'closed',
    /** Track settings. */
    scorePrompt: (trackId: string | null | undefined) => (find('track', trackId)?.settings.scorePrompt === 'score-fractional' ? 'score-fractional' : 'score'),
    showsTerms: (trackId: string | null | undefined) => Boolean(find('track', trackId)?.settings.terms),
  };
  return api;
}

/** The lists for one database: makeApi's helpers. */
export type Lookups = ReturnType<typeof makeApi>;

/** A quoted SQL list of IDs, e.g. ('new', 'applied'). IDs are validated, so inlining them is safe. */
export function sqlList(ids: string[]) {
  for (const id of ids) if (!ID.test(id)) throw new Error(`Not a list value ID: ${id}`);
  return ids.length ? `(${ids.map((id) => `'${id}'`).join(', ')})` : "('')";
}

/** An ID from a label: "Phone screen" -> phone_screen; suffixed when taken. */
export function idFromLabel(label: unknown, taken: string[] = []) {
  let base = String(label ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
  if (!base) base = 'value';
  if (!/^[a-z]/.test(base)) base = `v_${base}`;
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}_${n}`;
  return id;
}

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

function checkList(list: string) {
  if (!LISTS.includes(list)) throw bad(`Unknown list "${list}". Lists: ${LISTS.join(', ')}.`);
}

async function checkLabel(db: Db, list: string, label: unknown, exceptId: string | null = null) {
  const l = String(label ?? '').trim();
  if (!l) throw bad('Enter a label.');
  if (l.length > 60) throw bad('Keep the label to 60 characters or fewer.');
  const clash = (await lookups(db)).values(list).find((v) => v.id !== exceptId && v.label.toLowerCase() === l.toLowerCase());
  if (clash) throw bad(`"${clash.label}" is already in the ${list} list${clash.archived ? ' (archived; restore it instead)' : ''}.`);
  return l;
}

function checkGroup(list: string, group: unknown) {
  const groups = GROUPS[list] as Array<{ key: string; label: string }>;
  if (!groups.some((g) => g.key === group)) throw bad(`Choose a group: ${groups.map((g) => g.label).join(', ')}.`);
}

function checkSettings(list: string, settings: { scorePrompt?: string; terms?: unknown } | null | undefined) {
  if (list !== 'track') return null;
  const s = { scorePrompt: settings?.scorePrompt ?? 'score', terms: Boolean(settings?.terms) };
  if (!SCORE_PROMPTS.includes(s.scorePrompt)) throw bad(`The scoring prompt must be one of: ${SCORE_PROMPTS.join(', ')}.`);
  return s;
}

/** Adds a value; returns its new ID. The label check, the new ID, and the insert are one transaction. */
export async function addValue(db: Db, list: string, { label, group, settings }: { label: unknown; group?: string; settings?: { scorePrompt?: string; terms?: unknown } }, now = new Date()) {
  checkList(list);
  const q = db;
  try {
    return await q.tx(async () => {
      const l = await checkLabel(q, list, label);
      const g = list === 'track' ? 'track' : group;
      checkGroup(list, g);
      const all = (await lookups(q)).values(list);
      const id = idFromLabel(l, all.map((v) => v.id));
      const order = Math.max(0, ...all.map((v) => v.order)) + 10;
      await q
        .prepare(`INSERT INTO lookup_values (list, id, label, group_key, sort_order, settings_json, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'custom', ?, ?)`)
        .run(list, id, l, g, order, JSON.stringify(checkSettings(list, settings)), now.toISOString(), now.toISOString());
      return id;
    });
  } finally {
    invalidateLookups(q);
  }
}

/** Changes a value's label, group, settings, or archived state. Refuses changes that would break a role. */
export async function updateValue(
  db: Db,
  list: string,
  id: string,
  patch: { label?: unknown; group?: string; settings?: { scorePrompt?: string; terms?: unknown }; archived?: boolean },
  now = new Date(),
) {
  checkList(list);
  const q = db;
  try {
    await q.tx(async () => {
      await changeValue(q, list, id, patch, now);
    });
  } finally {
    invalidateLookups(q);
  }
  return (await lookups(q)).get(list, id);
}

/** updateValue's checks and write, inside its transaction. */
async function changeValue(
  db: Db,
  list: string,
  id: string,
  patch: { label?: unknown; group?: string; settings?: { scorePrompt?: string; terms?: unknown }; archived?: boolean },
  now: Date,
) {
  const lk = await lookups(db);
  const v = lk.get(list, id);
  if (!v) throw Object.assign(new Error(`No ${list} value "${id}".`), { statusCode: 404 });
  const set: Record<string, string | null> = {};
  if (patch.label !== undefined) set.label = await checkLabel(db, list, patch.label, id);
  const roleNames = Object.entries(lk.roles(list)).filter(([, vid]) => vid === id).map(([r]) => r);
  if (patch.group !== undefined && list !== 'track') {
    checkGroup(list, patch.group);
    for (const r of roleNames) {
      const allowed = ROLES[list]?.[r];
      if (allowed && !allowed.includes(patch.group)) throw bad(`"${v.label}" is the ${(ROLE_LABELS[r] as string).toLowerCase()}, which must be in ${allowed.join(' or ')}. Move that role first.`);
    }
    set.group_key = patch.group;
  }
  if (patch.settings !== undefined) set.settings_json = JSON.stringify(checkSettings(list, { ...v.settings, ...patch.settings }));
  if (patch.archived !== undefined) {
    if (patch.archived && roleNames.length) throw bad(`"${v.label}" is the ${roleNames.map((r) => (ROLE_LABELS[r] as string).toLowerCase()).join(' and ')}. Choose another value for that first.`);
    set.archived_at = patch.archived ? now.toISOString() : null;
  }
  const keys = Object.keys(set);
  if (keys.length) {
    await db
      .prepare(`UPDATE lookup_values SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE list = @list AND id = @id`)
      .run({ ...set, now: now.toISOString(), list, id });
  }
}

/** Moves a value one place up (-1) or down (+1) in its list. */
export async function moveValue(db: Db, list: string, id: string, direction: number) {
  checkList(list);
  const q = db;
  try {
    // The order is read and swapped in one transaction.
    await q.tx(async () => {
      const all = (await lookups(q)).values(list);
      const i = all.findIndex((v) => v.id === id);
      const j = i + (direction < 0 ? -1 : 1);
      if (i < 0) throw Object.assign(new Error(`No ${list} value "${id}".`), { statusCode: 404 });
      if (j < 0 || j >= all.length) return;
      const swap = q.prepare('UPDATE lookup_values SET sort_order = ? WHERE list = ? AND id = ?');
      const a = all[i] as LookupValue;
      const b = all[j] as LookupValue;
      await swap.run(b.order, list, a.id);
      await swap.run(a.order === b.order ? a.order + (direction < 0 ? 1 : -1) : a.order, list, b.id);
    });
  } finally {
    invalidateLookups(q);
  }
}

/** Points a role (for example the default status) at another value. */
export async function setRole(db: Db, list: string, role: string, valueId: string) {
  checkList(list);
  const listRoles = ROLES[list] as Record<string, string[] | null>;
  if (!listRoles[role] && listRoles[role] !== null) throw bad(`The ${list} list has no role "${role}".`);
  const q = db;
  try {
    // The value's checks and the role change are one transaction, so the value can not be archived in between.
    await q.tx(async () => {
      const v = (await lookups(q)).get(list, valueId);
      if (!v) throw bad(`No ${list} value "${valueId}".`);
      if (v.archived) throw bad(`"${v.label}" is archived; restore it first.`);
      const allowed = listRoles[role];
      if (allowed && !allowed.includes(v.group)) throw bad(`The ${(ROLE_LABELS[role] as string).toLowerCase()} must be in ${allowed.join(' or ')}.`);
      await q.prepare('INSERT INTO lookup_roles (list, role, value_id) VALUES (?, ?, ?) ON CONFLICT (list, role) DO UPDATE SET value_id = excluded.value_id').run(list, role, valueId);
    });
  } finally {
    invalidateLookups(q);
  }
}

/** How many jobs use each value of a list. */
export async function usageCounts(db: Db, list: string): Promise<Record<string, number>> {
  checkList(list);
  return Object.fromEntries(((await db.prepare(`SELECT ${list} AS id, COUNT(*) AS n FROM postings WHERE user_id = @uid GROUP BY ${list}`).all()) as Array<{ id: string; n: number }>).map((r) => [r.id, r.n]));
}
