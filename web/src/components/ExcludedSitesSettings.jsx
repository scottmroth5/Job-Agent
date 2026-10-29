import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useDemo } from '../demo.jsx';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One skipped site: its note (edited in place), how many saved jobs it still has, and Stop skipping. */
function SiteRow({ s, demo, onChange, onError }) {
  const [note, setNote] = useState(s.note ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setNote(s.note ?? ''), [s.note]);
  const act = async (fn) => {
    setBusy(true);
    onError(null);
    try {
      await onChange(await fn());
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="skip-site">
      <div className="row">
        <b>{s.site}</b>
        {s.addedAt && <span className="muted small">since {new Date(s.addedAt).toLocaleDateString()}</span>}
        {s.savedJobs > 0 && <span className="badge warn">{plural(s.savedJobs, 'saved job')}</span>}
      </div>
        <div className="row">
          <input
            aria-label={`Note for ${s.site}`}
            value={note}
            maxLength={300}
            placeholder="Why you skip it (optional)"
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== (s.note ?? '') && act(() => api.setSiteNote(s.site, note))}
          />
          {s.savedJobs > 0 && (
            <button type="button" disabled={busy} onClick={() => act(() => api.removeSiteJobs(s.site))}>
              Remove {plural(s.savedJobs, 'saved job')}
            </button>
          )}
          <button type="button" className="link" disabled={busy} onClick={() => act(() => api.unskipSite(s.site))}>
            Stop skipping
          </button>
        </div>
    </li>
  );
}

/**
 * Settings: job sites to skip, each with a note. Links to them are never kept (discovery, adding a job, scoring); saved
 * jobs from a site are removed only when you ask, and jobs you applied to never are.
 */
export default function ExcludedSitesSettings() {
  const demo = useDemo();
  const [data, setData] = useState(null);
  const [site, setSite] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.excludedSites().then(setData, (err) => setError(err.message));
  }, []);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setData(await api.skipSite(site.trim(), note.trim()));
      setSite('');
      setNote('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const changed = async (d) => setData(d.sites ? d : await api.excludedSites());

  return (
    <section className="home-card">
      <h2>Job sites to skip</h2>
      <p className="muted small">
        Sites whose links are a waste of your time (a paywall, charging to apply, reposted jobs). New jobs from them are never kept, and adding one by
        hand is refused. Use the employer's own posting instead.
      </p>
      {!data ? (
        error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>
      ) : (
        <>
          {data.sites.length === 0 && data.fromFile.length === 0 && <p className="muted">No sites skipped yet.</p>}
          <ul className="skip-sites">
            {data.sites.map((s) => (
              <SiteRow key={s.site} s={s} demo={demo} onChange={changed} onError={setError} />
            ))}
            {data.fromFile.map((s) => (
              <li key={`file-${s.site}`} className="skip-site">
                <div className="row">
                  <b>{s.site}</b>
                  <span className="muted small">from your settings file (search.excludedSites)</span>
                  {s.savedJobs > 0 && (
                    <button type="button" onClick={() => api.removeSiteJobs(s.site).then(changed, (err) => setError(err.message))}>
                      Remove {plural(s.savedJobs, 'saved job')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
            <form className="row skip-form" onSubmit={add}>
              <label>
                Site
                <input value={site} maxLength={300} placeholder="example-jobs.com, or a link to a job on it" onChange={(e) => setSite(e.target.value)} />
              </label>
              <label>
                Note
                <input value={note} maxLength={300} placeholder="Why (optional), e.g. paywall" onChange={(e) => setNote(e.target.value)} />
              </label>
              <button type="submit" className="primary" disabled={busy || site.trim().length < 3}>
                Skip this site
              </button>
            </form>
          {error && <div className="error">{error}</div>}
        </>
      )}
    </section>
  );
}
