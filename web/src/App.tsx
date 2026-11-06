import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { api, setDemoMode } from './api.ts';
import type { ApiResponse, JobRow } from './api.ts';
import type { Me } from './me.tsx';
import { startAnalytics, track } from './analytics.ts';
import { useLookups } from './lookups.tsx';
import JobTable from './components/JobTable.tsx';
import DetailPanel from './components/DetailPanel.tsx';
import AddJobDialog from './components/AddJobDialog.tsx';
import StackingBar from './components/StackingBar.tsx';
import AdminPage from './components/AdminPage.tsx';
import InboxPage from './components/InboxPage.tsx';
import HomePage from './components/HomePage.tsx';
import ActivityPage from './components/ActivityPage.tsx';
import FunnelPage from './components/FunnelPage.tsx';
import { DemoBanner, DemoContext, DemoNotice } from './demo.tsx';
import { MeContext } from './me.tsx';
import SettingsPage from './components/SettingsPage.tsx';
import HelpPage from './components/HelpPage.tsx';
import { DashIcon } from './components/DashIcon.tsx';

// #/ is the Home page; each screen has its own address.
const VIEWS: Record<string, string | undefined> = { jobs: 'Jobs', inbox: 'Inbox', funnel: 'Funnel', activity: 'Activity', admin: 'Admin', settings: 'Settings', help: 'Help' };
const viewFromHash = () => {
  const name = /^#\/(\w+)/.exec(window.location.hash)?.[1];
  return name && VIEWS[name] ? name : 'home';
};
// #/activity/12 opens task 12's output.
const activityIdFromHash = () => /^#\/activity\/(\w+)/.exec(window.location.hash)?.[1] ?? null;

// 'active' (Needs action) is new jobs to evaluate and offers to decide; applied and interviewing are under 'progress'.
type Filters = { track: string; stage: string; status: string; needsDescription: boolean; discoveredAfter: string; q: string; minScore: string };
const DEFAULT_FILTERS: Filters = { track: 'all', stage: 'pipeline', status: 'active', needsDescription: false, discoveredAfter: '', q: '', minScore: '' };
// v2 since the default status changed; a filter saved under the old key would keep showing everything.
const FILTERS_KEY = 'jobHuntFilters.v2';

function loadFilters(): Filters {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}') };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export default function App() {
  const lk = useLookups();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api
      .me()
      .then((m) => {
        setDemoMode(m?.demo); // before any change can be made: the demo stops changes and samples AI (api.ts)
        if (m?.demo) startAnalytics(m.analytics); // the demo's usage counts, when configured (analytics.js)
        setMe(m);
      })
      .catch(() => {});
  }, []);
  const [filters, setFilters] = useState(loadFilters);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [summary, setSummary] = useState<ApiResponse<'GET /api/summary'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<JobRow['id'] | null>(null);
  const [adding, setAdding] = useState(false);
  const [stack, setStack] = useState<Array<JobRow['id']>>([]);
  const [view, setView] = useState(viewFromHash);
  const [activityId, setActivityId] = useState(activityIdFromHash);

  useEffect(() => {
    const onHash = () => {
      setView(viewFromHash());
      setActivityId(activityIdFromHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Back on Home: fresh counts and setup steps (a key or search saved in Settings shows at once).
  useEffect(() => {
    if (view === 'home') void refresh();
    // Only a change of view refreshes here; filter changes refresh through their own effect.
  }, [view]);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, s] = await Promise.all([api.list(filters.needsDescription ? { ...filters, stage: 'all' } : filters), api.summary()]);
      setJobs(list);
      setSummary(s);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
    } catch {
      // private mode; filters just are not remembered
    }
    const t = setTimeout(refresh, filters.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [filters, refresh]);

  useEffect(() => {
    if (!lk.lists.status.length) return;
    const fix: Partial<Filters> = {};
    if (filters.track !== 'all' && !lk.get('track', filters.track)) fix.track = 'all';
    if (filters.stage !== 'all' && !lk.get('stage', filters.stage)) fix.stage = lk.roles.stage.promote ?? 'all';
    if (!['all', 'active', 'progress'].includes(filters.status) && !lk.get('status', filters.status)) fix.status = 'active';
    if (Object.keys(fix).length) setFilters((f) => ({ ...f, ...fix }));
  }, [lk, filters.track, filters.stage, filters.status]);

  const demo = Boolean(me?.demo);
  // The demo's usage counts: the screen's fixed name, and that a job was opened (never which). Outside the demo,
  // track does nothing.
  useEffect(() => {
    if (demo) track('section_viewed', { section: view });
  }, [demo, view]);
  useEffect(() => {
    if (demo && selectedId) track('job_viewed');
  }, [demo, selectedId]);
  const set = (key: keyof Filters) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const toggleStack = (id: JobRow['id']) => setStack((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  // Advanced filters live behind a link; the link shows how many are in use so a hidden one is never forgotten.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const advancedInUse = [filters.track !== 'all', filters.needsDescription, Boolean(filters.discoveredAfter), Boolean(filters.minScore)].filter(Boolean).length;
  const resetAdvanced = () => setFilters((f) => ({ ...f, track: 'all', needsDescription: false, discoveredAfter: '', minScore: '' }));
  const shortName = me?.email ? me.email.split('@')[0] : null;
  const signOut = async () => {
    await api.signOut();
    window.location.href = '/auth/signed-out';
  };

  return (
    <DemoContext.Provider value={demo}>
    <MeContext.Provider value={me}>
    <div className={demo ? 'app demo' : 'app'}>
      {demo && <DemoBanner requestAccessUrl={me?.requestAccessUrl} supportEmail={me?.supportEmail} />}
      {demo && <DemoNotice />}
      <header className="topbar">
        {view !== 'home' && (
          <a href="#/" className="home-link" aria-label="Home">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            <DashIcon name="home" className="home-img" />
            <span>Home</span>
          </a>
        )}
        <h1>
          <a href="#/">Job Hunt</a>
          {shortName && (
            <span className="who" title={me?.demo ? `The demo's sample candidate, ${me.name ?? me.email}` : `Signed in with Google as ${me?.email}`}>
              {' '}({shortName})
            </span>
          )}
          {view !== 'home' && <span className="page-name">{VIEWS[view]}</span>}
        </h1>
        {/* Wide screens keep the screen links; phones use the Home page tiles and the back link. */}
        <nav className="views" aria-label="Screens">
          <a href="#/" className={view === 'home' ? 'on' : ''}>Home</a>
          {Object.entries(VIEWS).filter(([k]) => (k !== 'inbox' || demo || me?.owner) && (k !== 'admin' || (!demo && me?.role === 'admin'))).map(([k, label]) => (
            <a key={k} href={`#/${k}`} className={view === k ? 'on' : ''}>
              {label}
              {k === 'inbox' && summary?.inboxNeedsReview ? <span className="count-badge" title="Emails to review">{summary.inboxNeedsReview}</span> : null}
            </a>
          ))}
        </nav>
      </header>

      {view === 'home' ? (
        <>
          <HomePage summary={summary} demo={demo} onAddJob={() => setAdding(true)} onOpenJob={setSelectedId} onPipelineFinished={refresh} onLayoutSaved={refresh} onChanged={refresh} />
          {me?.authMode === 'google' && (
            <p className="muted small signed-in">
              Signed in as {me.email} · <button className="link" onClick={signOut}>Sign out</button>
            </p>
          )}
        </>
      ) : view === 'settings' ? (
        <SettingsPage />
      ) : view === 'help' ? (
        <HelpPage />
      ) : view === 'admin' ? (
        <AdminPage />
      ) : view === 'funnel' ? (
        <FunnelPage onOpenJob={setSelectedId} />
      ) : view === 'activity' ? (
        <ActivityPage selectedId={activityId} />
      ) : view === 'inbox' ? (
        <InboxPage onOpenJob={setSelectedId} onChanged={refresh} />
      ) : (
      <>
      <div className="filters">
        <select value={filters.needsDescription ? 'all' : filters.stage} onChange={set('stage')} aria-label="Stage" disabled={filters.needsDescription} title={filters.needsDescription ? 'Needs description looks across all stages' : undefined}>
          {lk.options('stage', filters.stage).map((s) => (
            <option key={s.id} value={s.id}>{lk.label('stage', s.id, { markArchived: true })}</option>
          ))}
          <option value="all">All stages</option>
        </select>
        <select value={filters.status} onChange={set('status')} aria-label="Status">
          <option value="active">Needs action</option>
          <option value="progress">In progress</option>
          <option value="all">Any status</option>
          {lk.options('status', filters.status).map((s) => (
            <option key={s.id} value={s.id}>{lk.label('status', s.id, { markArchived: true })}</option>
          ))}
        </select>
        <input type="search" placeholder="Search role, company, location" value={filters.q} onChange={set('q')} aria-label="Search" />
        <button type="button" className="link advanced-toggle" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? 'Hide advanced filters' : 'Advanced filters'}
          {advancedInUse > 0 && <span className="count-badge" title="Advanced filters in use">{advancedInUse}</span>}
        </button>
          <button className="primary add-job" onClick={() => setAdding(true)}>
            + Add job
          </button>
      </div>
      {showAdvanced && (
      <div className="filters advanced">
        <div className="segmented" role="tablist" aria-label="Track">
          {[['all', 'All'], ...lk.options('track', filters.track).map((t) => [t.id, t.label])].map(([value, label]) => (
            <button key={value} role="tab" aria-selected={filters.track === value} className={filters.track === value ? 'on' : ''} onClick={() => setFilters((f) => ({ ...f, track: value }))}>
              {label}
            </button>
          ))}
        </div>
        <button
          className={`needs-desc-toggle${filters.needsDescription ? ' on' : ''}`}
          aria-pressed={filters.needsDescription}
          title="New jobs in any stage with no description whose title alone scored 7+ (shown capped at 5): paste the description, then Re-score"
          onClick={() => setFilters((f) => ({ ...f, needsDescription: !f.needsDescription }))}
        >
          Needs description{summary ? ` (${summary.needsDescription})` : ''}
        </button>
        <label className="date-filter" title="Only jobs discovered on or after this date">
          Discovered since
          <input type="date" value={filters.discoveredAfter} onChange={set('discoveredAfter')} max={new Date().toISOString().slice(0, 10)} />
        </label>
        <select value={filters.minScore} onChange={set('minScore')} aria-label="Minimum score">
          <option value="">Any score</option>
          {[9, 8, 7, 6, 5].map((n) => (
            <option key={n} value={n}>{n}+</option>
          ))}
        </select>
        {advancedInUse > 0 && (
          <button type="button" className="link" onClick={resetAdvanced}>
            Clear advanced filters
          </button>
        )}
      </div>
      )}

      {lk.showsTerms(filters.track) && summary?.fractionalTarget && (
        <StackingBar jobs={jobs.filter((j) => stack.includes(j.id))} target={summary.fractionalTarget} onClear={() => setStack([])} />
      )}

      {error && <div className="error">Could not load jobs: {error}</div>}
      <JobTable
        jobs={jobs}
        loading={loading}
        onOpen={setSelectedId}
        selectedId={selectedId}
        stackable={lk.showsTerms(filters.track)}
        stack={stack}
        onToggleStack={toggleStack}
      />
      </>
      )}

      {selectedId && <DetailPanel id={selectedId} onClose={() => setSelectedId(null)} onChanged={refresh} onOpen={setSelectedId} />}
      {adding && (
        <AddJobDialog
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            void refresh();
            if (id) setSelectedId(id);
          }}
        />
      )}
    </div>
    </MeContext.Provider>
    </DemoContext.Provider>
  );
}
