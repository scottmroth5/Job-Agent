// The configurable lists (agents/lookups.js): read them for the UI, and manage them on the Admin screen.
import { LISTS, GROUPS, ROLES, ROLE_LABELS, SCORE_PROMPTS, lookups, addValue, updateValue, moveValue, setRole, usageCounts } from '../agents/lookups.js';

const anyObject = { type: 'object', additionalProperties: true };
const listParams = { type: 'object', required: ['list'], properties: { list: { type: 'string', enum: LISTS } } };
const valueParams = { type: 'object', required: ['list', 'id'], properties: { list: { type: 'string', enum: LISTS }, id: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' } } };
const settingsSchema = { type: 'object', additionalProperties: false, properties: { scorePrompt: { type: 'string', enum: SCORE_PROMPTS }, terms: { type: 'boolean' } } };

/** Everything the UI needs to show and choose values: lists (archived values included, flagged), groups, roles. */
export function lookupsPayload(db, { counts = false } = {}) {
  const lk = lookups(db);
  return {
    lists: Object.fromEntries(
      LISTS.map((list) => {
        const used = counts ? usageCounts(db, list) : null;
        return [list, lk.values(list).map((v) => ({ ...v, ...(used ? { jobs: used[v.id] ?? 0 } : {}) }))];
      }),
    ),
    groups: GROUPS,
    roles: Object.fromEntries(LISTS.map((l) => [l, lk.roles(l)])),
    roleDefinitions: Object.fromEntries(LISTS.map((l) => [l, Object.entries(ROLES[l]).map(([role, groups]) => ({ role, label: ROLE_LABELS[role], groups }))])),
  };
}

export function registerLookupRoutes(app, { db }) {
  app.get('/api/lookups', { schema: { summary: 'Status, stage, and track lists with their groups and roles', response: { 200: anyObject } } }, async () => lookupsPayload(db));

  app.get('/api/admin/lookups', { schema: { summary: 'The lists with how many jobs use each value', response: { 200: anyObject } } }, async () => lookupsPayload(db, { counts: true }));

  app.post(
    '/api/admin/lookups/:list',
    {
      schema: {
        summary: 'Add a value to a list (its ID is made from the label and never changes)',
        params: listParams,
        body: { type: 'object', required: ['label'], additionalProperties: false, properties: { label: { type: 'string', maxLength: 60 }, group: { type: 'string' }, settings: settingsSchema } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const id = addValue(db, req.params.list, req.body);
      return { id, ...lookupsPayload(db, { counts: true }) };
    },
  );

  app.patch(
    '/api/admin/lookups/:list/:id',
    {
      schema: {
        summary: 'Rename, regroup, reorder, change settings, archive, or restore a value',
        params: valueParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            label: { type: 'string', maxLength: 60 },
            group: { type: 'string' },
            settings: settingsSchema,
            archived: { type: 'boolean' },
            move: { type: 'string', enum: ['up', 'down'] },
          },
        },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const { list, id } = req.params;
      const { move, ...patch } = req.body;
      if (move) moveValue(db, list, id, move === 'up' ? -1 : 1);
      if (Object.keys(patch).length) updateValue(db, list, id, patch);
      return lookupsPayload(db, { counts: true });
    },
  );

  app.put(
    '/api/admin/lookups/:list/roles',
    {
      schema: {
        summary: 'Point a role (default for new jobs, promotion stage, archive stage) at another value',
        params: listParams,
        body: { type: 'object', required: ['role', 'valueId'], additionalProperties: false, properties: { role: { type: 'string' }, valueId: { type: 'string' } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      setRole(db, req.params.list, req.body.role, req.body.valueId);
      return lookupsPayload(db, { counts: true });
    },
  );
}
