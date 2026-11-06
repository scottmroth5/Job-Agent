import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api.ts';

// The configurable status, stage, and track lists (GET /api/lookups), shared by every screen.

/** One list value as GET /api/lookups returns it (agents/lookups.ts LookupValue). */
export interface LookupValue {
  id: string;
  label: string;
  group: string;
  order: number;
  settings: { scorePrompt?: string; terms?: boolean };
  origin: string;
  archived: boolean;
  /** Admin > Lists only: how many jobs use it. */
  jobs?: number;
}
export type ListName = 'status' | 'stage' | 'track';
export interface LookupsData {
  lists: Record<ListName, LookupValue[]>;
  groups: Record<string, unknown>;
  roles: Record<ListName, Record<string, string | null | undefined>>;
  roleDefinitions: Record<string, unknown>;
}

const EMPTY: LookupsData = { lists: { status: [], stage: [], track: [] }, groups: {}, roles: { status: {}, stage: {}, track: {} }, roleDefinitions: {} };

function makeValue(data: LookupsData, refresh: () => Promise<void>) {
  const find = (list: ListName, id: string | null | undefined) => data.lists[list]?.find((v) => v.id === id) ?? null;
  return {
    ...data,
    refresh,
    get: find,
    /** The value's label; "(archived)" is added when asked and it is archived. */
    label: (list: ListName, id: string | null | undefined, { markArchived = false }: { markArchived?: boolean } = {}) => {
      const v = find(list, id);
      if (!v) return id ?? '';
      return markArchived && v.archived ? `${v.label} (archived)` : v.label;
    },
    /** Values to offer for a new choice: not archived, plus `keep` (a job's current value) even if archived. */
    options: (list: ListName, keep?: string | null) => (data.lists[list] ?? []).filter((v) => !v.archived || v.id === keep),
    groupOf: (list: ListName, id: string | null | undefined) => find(list, id)?.group ?? null,
    showsTerms: (trackId: string | null | undefined) => Boolean(find('track', trackId)?.settings?.terms),
  };
}
export type Lookups = ReturnType<typeof makeValue>;

const LookupsContext = createContext<Lookups | null>(null);

export function LookupsProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<LookupsData>(EMPTY);
  const refresh = useCallback(() => api.lookups().then(setData).catch(() => {}), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => makeValue(data, refresh), [data, refresh]);

  return <LookupsContext.Provider value={value}>{children}</LookupsContext.Provider>;
}

/** The lists; always inside LookupsProvider (main wraps the whole page). */
export const useLookups = () => useContext(LookupsContext) as Lookups;
