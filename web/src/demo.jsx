// The public demo (AUTH_MODE=demo): the server refuses every change, so the UI hides the controls that make one
// and says so in a banner. Components read the flag with useDemo(); CSS hides anything marked demo-hide.
import { createContext, useContext } from 'react';

export const DemoContext = createContext(false);
export const useDemo = () => useContext(DemoContext);

/** requestAccessUrl (REQUEST_ACCESS_URL): the real app, where someone can sign in and ask for access. */
export function DemoBanner({ requestAccessUrl = null }) {
  return (
    <div className="demo-banner" role="note">
      <strong>Demo</strong> · A fictional candidate&apos;s job search with made-up companies and sample data. Look around freely;
      changes and AI actions are turned off here.
      {requestAccessUrl && (
        <>
          {' '}
          <a href={requestAccessUrl}>Request access</a> to use it for your own search.
        </>
      )}
    </div>
  );
}
