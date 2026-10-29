// The public demo (AUTH_MODE=demo): every control is there, but nothing is saved and no AI is used. Changes are stopped
// in web/src/api.js before they are sent, and DemoNotice says so each time; AI actions answer with canned samples
// (demo/samples.js). The server refuses changes too. Components read the flag with useDemo().
import { createContext, useContext, useEffect, useState } from 'react';
import { DEMO_NOT_SAVED } from './api.js';

export const DemoContext = createContext(false);
export const useDemo = () => useContext(DemoContext);

/** requestAccessUrl (REQUEST_ACCESS_URL): the real app, where someone can sign in and ask for access. */
export function DemoBanner({ requestAccessUrl = null, supportEmail = null }) {
  return (
    <div className="demo-banner" role="note">
      <strong>Demo</strong> · A fictional candidate&apos;s job search with made-up companies and sample data. Try anything: buttons work, but nothing
      is saved, and AI answers are canned samples (no AI is used).
      {requestAccessUrl && (
        <>
          {' '}
          <a href={requestAccessUrl}>Request access</a> to use it for your own search.
        </>
      )}
      {supportEmail && (
        <>
          {' '}Questions: <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
        </>
      )}
    </div>
  );
}

/** A short notice each time the demo stops a change (api.js's demo-blocked event), at the bottom of the screen. */
export function DemoNotice() {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let timer;
    const on = () => {
      setShown((n) => n + 1);
      clearTimeout(timer);
      timer = setTimeout(() => setShown(0), 6000);
    };
    window.addEventListener('demo-blocked', on);
    return () => {
      window.removeEventListener('demo-blocked', on);
      clearTimeout(timer);
    };
  }, []);
  if (!shown) return null;
  return (
    <div className="demo-notice" role="status" key={shown}>
      <strong>{DEMO_NOT_SAVED.split(':')[0]}:</strong> {DEMO_NOT_SAVED.split(': ').slice(1).join(': ')}
      <button type="button" className="link" onClick={() => setShown(0)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
