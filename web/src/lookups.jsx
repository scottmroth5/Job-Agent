import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

// The configurable status, stage, and track lists (GET /api/lookups), shared by every screen.
const LookupsContext = createContext(null);

const EMPTY = { lists: { status: [], stage: [], track: [] }, groups: {}, roles: { status: {}, stage: {}, track: {} }, roleDefinitions: {} };

export function LookupsProvider({ children }) {
  const [data, setData] = useState(EMPTY);
  const refresh = useCallback(() => api.lookups().then(setData).catch(() => {}), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(() => {
    const find = (list, id) => data.lists[list]?.find((v) => v.id === id) ?? null;
    return {
      ...data,
      refresh,
      get: find,
      /** The value's label; "(archived)" is added when asked and it is archived. */
      label: (list, id, { markArchived = false } = {}) => {
        const v = find(list, id);
        if (!v) return id ?? '';
        return markArchived && v.archived ? `${v.label} (archived)` : v.label;
      },
      /** Values to offer for a new choice: not archived, plus `keep` (a job's current value) even if archived. */
      options: (list, keep) => (data.lists[list] ?? []).filter((v) => !v.archived || v.id === keep),
      groupOf: (list, id) => find(list, id)?.group ?? null,
      showsTerms: (trackId) => Boolean(find('track', trackId)?.settings?.terms),
    };
  }, [data, refresh]);

  return <LookupsContext.Provider value={value}>{children}</LookupsContext.Provider>;
}

export const useLookups = () => useContext(LookupsContext);
