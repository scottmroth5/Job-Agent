import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { STATUSES, STATUS_LABELS } from './format.js';
import JobTable from './components/JobTable.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import AddJobDialog from './components/AddJobDialog.jsx';
import StackingBar from './components/StackingBar.jsx';
import AdminPage from './components/AdminPage.jsx';
import InboxPage from './components/InboxPage.jsx';
import PipelineButton from './components/PipelineButton.jsx';

const viewFromHash = () => (window.location.hash.startsWith('#/admin') ? 'admin' : window.location.hash.startsWith('#/inbox') ? 'inbox' : 'jobs');

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
  const [filters, setFilters] = useState(loadFilters);
  const [jobs, setJobs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [stack, setStack] = useState([]);
  const [view, setView] = useState(viewFromHash);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
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

  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const toggleStack = (id) => setStack((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Job Hunt</h1>
          {summary && (
            <div className="muted small">
              {summary.pipeline} in pipeline · ${summary.spend30Days.toFixed(2)} spent in the last 30 days
            </div>
          )}
        </div>
        <nav className="views" aria-label="Screens">
          <a href="#/" className={view === 'jobs' ? 'on' : ''}>Jobs</a>
          <a href="#/inbox" className={view === 'inbox' ? 'on' : ''}>
            Inbox{summary?.inboxNeedsReview ? <span className="count-badge" title="Emails to review">{summary.inboxNeedsReview}</span> : null}
          </a>
          <a href="#/admin" className={view === 'admin' ? 'on' : ''}>Admin</a>
        </nav>
        <PipelineButton onFinished={refresh} />
        {view === 'jobs' && <button className="primary" onClick={() => setAdding(true)}>+ Add job</button>}
      </header>

      {view === 'admin' ? (
        <AdminPage />
      ) : view === 'inbox' ? (
        <InboxPage onOpenJob={setSelectedId} onChanged={refresh} />
      ) : (
      <>
      <div className="filters">
        <div className="segmented" role="tablist" aria-label="Track">
          {[
            ['all', 'All'],
            ['fulltime', 'Full-time'],
            ['fractional', 'Fractional'],
          ].map(([value, label]) => (
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
        <select value={filters.stage} onChange={set('stage')} aria-label="Stage" disabled={filters.needsDescription}>
          <option value="pipeline">Pipeline</option>
          <option value="discovered">Discovered</option>
          <option value="archived">Archived</option>
          <option value="all">All stages</option>
        </select>
        <select value={filters.status} onChange={set('status')} aria-label="Status">
          <option value="active">Needs action</option>
          <option value="progress">In progress</option>
          <option value="all">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
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
        <input type="search" placeholder="Search role, company, location" value={filters.q} onChange={set('q')} aria-label="Search" />
      </div>

      {filters.track === 'fractional' && summary?.fractionalTarget && (
        <StackingBar jobs={jobs.filter((j) => stack.includes(j.id))} target={summary.fractionalTarget} onClear={() => setStack([])} />
      )}

      {error && <div className="error">Could not load jobs: {error}</div>}
      <JobTable
        jobs={jobs}
        loading={loading}
        onOpen={setSelectedId}
        selectedId={selectedId}
        stackable={filters.track === 'fractional'}
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
  );
}
