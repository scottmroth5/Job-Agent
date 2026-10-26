import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { useLookups } from './lookups.jsx';
import JobTable from './components/JobTable.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import AddJobDialog from './components/AddJobDialog.jsx';
import StackingBar from './components/StackingBar.jsx';
import AdminPage from './components/AdminPage.jsx';
import InboxPage from './components/InboxPage.jsx';
import HomePage from './components/HomePage.jsx';
import ActivityPage from './components/ActivityPage.jsx';
import FunnelPage from './components/FunnelPage.jsx';
import { DemoBanner, DemoContext } from './demo.jsx';
import { MeContext } from './me.jsx';
import SettingsPage from './components/SettingsPage.jsx';

// #/ is the Home page; each screen has its own address.
const VIEWS = { jobs: 'Jobs', inbox: 'Inbox', funnel: 'Funnel', activity: 'Activity', admin: 'Admin', settings: 'Settings' };
const viewFromHash = () => {
  const name = /^#\/(\w+)/.exec(window.location.hash)?.[1];
  return VIEWS[name] ? name : 'home';
};
// #/activity/12 opens task 12's output.
const activityIdFromHash = () => /^#\/activity\/(\w+)/.exec(window.location.hash)?.[1] ?? null;

// 'active' (Needs action) is new jobs to evaluate and offers to decide; applied and interviewing are under 'progress'.
const DEFAULT_FILTERS = { track: 'all', stage: 'pipeline', status: 'active', needsDescription: false, discoveredAfter: '', q: '', minScore: '' };
// v2 since the default status changed; a filter saved under the old key would keep showing everything.
const FILTERS_KEY = 'jobHuntFilters.v2';

function loadFilters() {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}') };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export default function App() {
  const lk = useLookups();
  const [me, setMe] = useState(null);
  useEffect(() => {
    api.me().then(setMe).catch(() => {});
  }, []);
  const [filters, setFilters] = useState(loadFilters);
  const [jobs, setJobs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [stack, setStack] = useState([]);
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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, s] = await Promise.all([api.list(filters.needsDescription ? { ...filters, stage: 'all' } : filters), api.summary()]);
      setJobs(list);
      setSummary(s);
      setError(null);
    } catch (err) {
      setError(err.message);
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
    const fix = {};
    if (filters.track !== 'all' && !lk.get('track', filters.track)) fix.track = 'all';
    if (filters.stage !== 'all' && !lk.get('stage', filters.stage)) fix.stage = lk.roles.stage.promote ?? 'all';
    if (!['all', 'active', 'progress'].includes(filters.status) && !lk.get('status', filters.status)) fix.status = 'active';
    if (Object.keys(fix).length) setFilters((f) => ({ ...f, ...fix }));
  }, [lk, filters.track, filters.stage, filters.status]);

  const demo = Boolean(me?.demo);
  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const toggleStack = (id) => setStack((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
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
      {demo && <DemoBanner requestAccessUrl={me?.requestAccessUrl} />}
      <header className="topbar">
        {view !== 'home' && (
          <a href="#/" className="home-link" aria-label="Home">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            <span>Home</span>
          </a>
        )}
        <h1>
          <a href="#/">Job Hunt</a>
          {shortName && (
            <span className="who" title={`Signed in with Google as ${me.email}`}>
              {' '}({shortName})
            </span>
          )}
          {view !== 'home' && <span className="page-name">{VIEWS[view]}</span>}
        </h1>
        {/* Wide screens keep the screen links; phones use the Home page tiles and the back link. */}
        <nav className="views" aria-label="Screens">
          <a href="#/" className={view === 'home' ? 'on' : ''}>Home</a>
          {Object.entries(VIEWS).filter(([k]) => k !== 'inbox' || demo || me?.owner).map(([k, label]) => (
            <a key={k} href={`#/${k}`} className={view === k ? 'on' : ''}>
              {label}
              {k === 'inbox' && summary?.inboxNeedsReview ? <span className="count-badge" title="Emails to review">{summary.inboxNeedsReview}</span> : null}
            </a>
          ))}
        </nav>
      </header>

      {view === 'home' ? (
        <>
          <HomePage summary={summary} demo={demo} onAddJob={() => setAdding(true)} onPipelineFinished={refresh} onLayoutSaved={refresh} />
          {me?.authMode === 'google' && (
            <p className="muted small signed-in">
              Signed in as {me.email} · <button className="link" onClick={signOut}>Sign out</button>
            </p>
          )}
        </>
      ) : view === 'settings' ? (
        <SettingsPage />
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
        <select value={filters.stage} onChange={set('stage')} aria-label="Stage" disabled={filters.needsDescription}>
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
        {!demo && (
          <button className="primary add-job" onClick={() => setAdding(true)}>
            + Add job
          </button>
        )}
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
          title="New jobs that scored 7+ from the title alone: paste the description, then Re-score"
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
            refresh();
            if (id) setSelectedId(id);
          }}
        />
      )}
    </div>
    </MeContext.Provider>
    </DemoContext.Provider>
  );
}
