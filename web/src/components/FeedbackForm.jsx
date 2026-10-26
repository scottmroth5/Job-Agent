import { useState } from 'react';
import { api } from '../api.js';
import { useMe } from '../me.jsx';

/** Settings > Send feedback: a note to the owner, who can reply by email. */
export default function FeedbackForm() {
  const support = useMe()?.supportEmail;
  const [body, setBody] = useState('');
  const [state, setState] = useState(null); // null, 'sending', 'sent', or an error message
  const send = async (e) => {
    e.preventDefault();
    setState('sending');
    try {
      await api.sendFeedback(body.trim(), window.location.hash.slice(0, 100));
      setBody('');
      setState('sent');
    } catch (err) {
      setState(err.message);
    }
  };
  return (
    <section className="home-card">
      <h2>Send feedback</h2>
      <p className="muted small">
        Something broken, confusing, or missing? It goes to the owner, who can reply to you by email.
        {support && (
          <>
            {' '}Or email <a href={`mailto:${support}`}>{support}</a>.
          </>
        )}
      </p>
      <form onSubmit={send}>
        <textarea className="profile-text" rows={4} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row">
          <button className="primary" type="submit" disabled={!body.trim() || state === 'sending'}>
            {state === 'sending' ? 'Sending…' : 'Send'}
          </button>
          {state === 'sent' && <span className="muted small">Thanks, sent.</span>}
          {state && !['sending', 'sent'].includes(state) && <span className="error">{state}</span>}
        </div>
      </form>
    </section>
  );
}
