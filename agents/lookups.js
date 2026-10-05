// The configurable lists (status, stage, track): the one place that knows their values, groups, and roles.
// Jobs store each value's immutable text ID. Behavior comes from the value's group, never from its ID, so
// added values work everywhere the built-in ones do. Values are archived, never deleted: an archived value
// stays valid on the jobs that have it, and drops out of menus and automation targets.

export const LISTS = ['status', 'stage', 'track'];

/** Groups per list, in order, with what each one means. */
export const GROUPS = {
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
const STATUS_GROUP = {
  evaluate: { rank: 0, needsAction: true, inProgress: false, autoArchive: 'age' },
  waiting: { rank: 1, needsAction: false, inProgress: true, autoArchive: 'age' },
  conversation: { rank: 2, needsAction: false, inProgress: true, autoArchive: 'never' },
  decision: { rank: 3, needsAction: true, inProgress: true, autoArchive: 'never' },
  closed: { rank: null, needsAction: false, inProgress: false, autoArchive: 'now' },
};

/** Roles a list has, and which group the value holding each role must be in (null: any). */
export const ROLES = {
  status: { default: ['evaluate'] },
  stage: { default: ['found', 'active'], promote: ['active'], archive: ['archived'] },
  track: { default: null },
};
export const ROLE_LABELS = { default: 'Default for new jobs', promote: 'Where 7+ jobs are promoted', archive: 'Where archived jobs go' };

export const SCORE_PROMPTS = ['score', 'score-fractional'];
const ID = /^[a-z][a-z0-9_]{0,39}$/;

const cache = new WeakMap();

function read(db) {
  const rows = db.prepare('SELECT * FROM lookup_values ORDER BY list, sort_order, id').all();
  const roles = db.prepare('SELECT list, role, value_id FROM lookup_roles').all();
  const byList = Object.fromEntries(LISTS.map((l) => [l, []]));
  for (const r of rows) {
    byList[r.list].push({
      id: r.id,
      label: r.label,
      group: r.group_key,
      order: r.sort_order,
      settings: r.settings_json ? JSON.parse(r.settings_json) : {},
      origin: r.origin,
      archived: Boolean(r.archived_at),
    });
  }
  const roleMap = Object.fromEntries(LISTS.map((l) => [l, {}]));
  for (const r of roles) roleMap[r.list][r.role] = r.value_id;
  return { byList, roles: roleMap };
}

/** Drops the cached lists (call after any edit). */
export const invalidateLookups = (db) => cache.delete(db);

/**
 * The lists for this database, cached until invalidateLookups(db). Helpers include archived values,
 * because their behavior still applies to the jobs that have them.
 */
export function lookups(db) {
  if (cache.has(db)) return cache.get(db);
  const { byList, roles } = read(db);
  const find = (list, id) => byList[list]?.find((v) => v.id === id) ?? null;
  const statusIds = (pred) => byList.status.filter((v) => pred(STATUS_GROUP[v.group] ?? {})).map((v) => v.id);
  const api = {
    values: (list, { includeArchived = true } = {}) => byList[list].filter((v) => includeArchived || !v.archived),
    get: find,
    label: (list, id) => find(list, id)?.label ?? id,
    groupOf: (list, id) => find(list, id)?.group ?? null,
    /** IDs in any of the given groups. */
    ids: (list, ...groups) => byList[list].filter((v) => groups.includes(v.group)).map((v) => v.id),
    role: (list, name) => roles[list]?.[name] ?? null,
    roles: (list) => ({ ...roles[list] }),
    /** True when the value exists and is not archived (allowed for a new choice). */
    selectable: (list, id) => Boolean(find(list, id) && !find(list, id).archived),
    /** Status behavior. */
    needsAction: () => statusIds((g) => g.needsAction),
    inProgress: () => statusIds((g) => g.inProgress),
    open: () => statusIds((g) => g.inProgress),
    closed: () => statusIds((g) => g.autoArchive === 'now'),
    neverAutoArchived: () => statusIds((g) => g.autoArchive === 'never'),
    /** Forward-only rank of a status: 0..3, or null for a closed (terminal) status. */
    rank: (statusId) => STATUS_GROUP[find('status', statusId)?.group]?.rank ?? null,
    isClosed: (statusId) => find('status', statusId)?.group === 'closed',
    /** Track settings. */
    scorePrompt: (trackId) => (find('track', trackId)?.settings.scorePrompt === 'score-fractional' ? 'score-fractional' : 'score'),
    showsTerms: (trackId) => Boolean(find('track', trackId)?.settings.terms),
  };
  cache.set(db, api);
  return api;
}

/** A quoted SQL list of IDs, e.g. ('new', 'applied'). IDs are validated, so inlining them is safe. */
export function sqlList(ids) {
  for (const id of ids) if (!ID.test(id)) throw new Error(`Not a list value ID: ${id}`);
  return ids.length ? `(${ids.map((id) => `'${id}'`).join(', ')})` : "('')";
}

/** An ID from a label: "Phone screen" -> phone_screen; suffixed when taken. */
export function idFromLabel(label, taken = []) {
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

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });

function checkList(list) {
  if (!LISTS.includes(list)) throw bad(`Unknown list "${list}". Lists: ${LISTS.join(', ')}.`);
}

function checkLabel(db, list, label, exceptId = null) {
  const l = String(label ?? '').trim();
  if (!l) throw bad('Enter a label.');
  if (l.length > 60) throw bad('Keep the label to 60 characters or fewer.');
  const clash = lookups(db).values(list).find((v) => v.id !== exceptId && v.label.toLowerCase() === l.toLowerCase());
  if (clash) throw bad(`"${clash.label}" is already in the ${list} list${clash.archived ? ' (archived; restore it instead)' : ''}.`);
  return l;
}

function checkGroup(list, group) {
  if (!GROUPS[list].some((g) => g.key === group)) throw bad(`Choose a group: ${GROUPS[list].map((g) => g.label).join(', ')}.`);
}

function checkSettings(list, settings) {
  if (list !== 'track') return null;
  const s = { scorePrompt: settings?.scorePrompt ?? 'score', terms: Boolean(settings?.terms) };
  if (!SCORE_PROMPTS.includes(s.scorePrompt)) throw bad(`The scoring prompt must be one of: ${SCORE_PROMPTS.join(', ')}.`);
  return s;
}

/** Adds a value; returns its new ID. */
export function addValue(db, list, { label, group, settings }, now = new Date()) {
  checkList(list);
  const l = checkLabel(db, list, label);
  const g = list === 'track' ? 'track' : group;
  checkGroup(list, g);
  const all = lookups(db).values(list);
  const id = idFromLabel(l, all.map((v) => v.id));
  const order = Math.max(0, ...all.map((v) => v.order)) + 10;
  db.prepare(`INSERT INTO lookup_values (list, id, label, group_key, sort_order, settings_json, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'custom', ?, ?)`).run(list, id, l, g, order, JSON.stringify(checkSettings(list, settings)), now.toISOString(), now.toISOString());
  invalidateLookups(db);
  return id;
}

/** Changes a value's label, group, settings, or archived state. Refuses changes that would break a role. */
export function updateValue(db, list, id, patch, now = new Date()) {
  checkList(list);
  const lk = lookups(db);
  const v = lk.get(list, id);
  if (!v) throw Object.assign(new Error(`No ${list} value "${id}".`), { statusCode: 404 });
  const set = {};
  if (patch.label !== undefined) set.label = checkLabel(db, list, patch.label, id);
  const roleNames = Object.entries(lk.roles(list)).filter(([, vid]) => vid === id).map(([r]) => r);
  if (patch.group !== undefined && list !== 'track') {
    checkGroup(list, patch.group);
    for (const r of roleNames) {
      const allowed = ROLES[list][r];
      if (allowed && !allowed.includes(patch.group)) throw bad(`"${v.label}" is the ${ROLE_LABELS[r].toLowerCase()}, which must be in ${allowed.join(' or ')}. Move that role first.`);
    }
    set.group_key = patch.group;
  }
  if (patch.settings !== undefined) set.settings_json = JSON.stringify(checkSettings(list, { ...v.settings, ...patch.settings }));
  if (patch.archived !== undefined) {
    if (patch.archived && roleNames.length) throw bad(`"${v.label}" is the ${roleNames.map((r) => ROLE_LABELS[r].toLowerCase()).join(' and ')}. Choose another value for that first.`);
    set.archived_at = patch.archived ? now.toISOString() : null;
  }
  const keys = Object.keys(set);
  if (keys.length) {
    db.prepare(`UPDATE lookup_values SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE list = @list AND id = @id`).run({ ...set, now: now.toISOString(), list, id });
    invalidateLookups(db);
  }
  return lookups(db).get(list, id);
}

/** Moves a value one place up (-1) or down (+1) in its list. */
export function moveValue(db, list, id, direction) {
  checkList(list);
  const all = lookups(db).values(list);
  const i = all.findIndex((v) => v.id === id);
  const j = i + (direction < 0 ? -1 : 1);
  if (i < 0) throw Object.assign(new Error(`No ${list} value "${id}".`), { statusCode: 404 });
  if (j < 0 || j >= all.length) return;
  const swap = db.prepare('UPDATE lookup_values SET sort_order = ? WHERE list = ? AND id = ?');
  db.transaction(() => {
    swap.run(all[j].order, list, all[i].id);
    swap.run(all[i].order === all[j].order ? all[i].order + (direction < 0 ? 1 : -1) : all[i].order, list, all[j].id);
  })();
  invalidateLookups(db);
}

/** Points a role (for example the default status) at another value. */
export function setRole(db, list, role, valueId) {
  checkList(list);
  if (!ROLES[list][role] && ROLES[list][role] !== null) throw bad(`The ${list} list has no role "${role}".`);
  const lk = lookups(db);
  const v = lk.get(list, valueId);
  if (!v) throw bad(`No ${list} value "${valueId}".`);
  if (v.archived) throw bad(`"${v.label}" is archived; restore it first.`);
  const allowed = ROLES[list][role];
  if (allowed && !allowed.includes(v.group)) throw bad(`The ${ROLE_LABELS[role].toLowerCase()} must be in ${allowed.join(' or ')}.`);
  db.prepare('INSERT INTO lookup_roles (list, role, value_id) VALUES (?, ?, ?) ON CONFLICT (list, role) DO UPDATE SET value_id = excluded.value_id').run(list, role, valueId);
  invalidateLookups(db);
}

/** How many jobs use each value of a list. */
export function usageCounts(db, list) {
  checkList(list);
  return Object.fromEntries(db.prepare(`SELECT ${list} AS id, COUNT(*) AS n FROM postings GROUP BY ${list}`).all().map((r) => [r.id, r.n]));
}
