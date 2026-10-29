import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useDemo } from '../demo.jsx';

/**
 * Settings: follow-ups. An application with no reply is worth a follow-up from followUpFrom days until the stale days;
 * after that it is stale, and Home offers to close it as no response (server/follow-up-routes.js).
 */
export default function FollowUpSettings() {
  const demo = useDemo();
  const [data, setData] = useState(null);
  const [days, setDays] = useState('');
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const show = (d) => {
    setData((old) => ({ ...old, ...d }));
    setDays(String(d.staleDays));
  };
  useEffect(() => {
    api.followUps().then(show, (err) => setError(err.message));
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    setNote(null);
    try {
      show(await api.setStaleDays(Number(days)));
      show(await api.followUps());
      setNote('Saved.');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="home-card">
      <h2>Follow-ups</h2>
      {!data ? (
        error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="muted small">
            An application with no reply shows as a follow-up from {data.followUpFrom} days after you applied: the job's Next step offers Find someone to contact. After the
            days below it is stale, and Home offers to close it as no response.
          </p>
          <form className="row skip-form" onSubmit={save}>
            <label>
              Stale after (days with no reply)
              <input type="number" min={data.min} max={data.max} step={1} value={days} disabled={demo} onChange={(e) => setDays(e.target.value)} />
            </label>
            {!demo && (
              <button type="submit" className="primary" disabled={!days || Number(days) === data.staleDays}>
                Save
              </button>
            )}
            {!demo && data.staleDays !== data.defaultStaleDays && (
              <button type="button" onClick={() => setDays(String(data.defaultStaleDays))}>
                Use the default ({data.defaultStaleDays})
              </button>
            )}
          </form>
          <p className="small">
            Now: {data.followUp} worth a follow-up, {data.stale} stale.
          </p>
          {note && <p className="muted small">{note}</p>}
          {error && <div className="error">{error}</div>}
        </>
      )}
    </section>
  );
}
