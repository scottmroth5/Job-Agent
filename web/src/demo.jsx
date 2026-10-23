// The public demo (AUTH_MODE=demo): the server refuses every change, so the UI hides the controls that make one
// and says so in a banner. Components read the flag with useDemo(); CSS hides anything marked demo-hide.
import { createContext, useContext } from 'react';

export const DemoContext = createContext(false);
export const useDemo = () => useContext(DemoContext);

export function DemoBanner() {
  return (
    <div className="demo-banner" role="note">
      <strong>Demo</strong> · A fictional candidate&apos;s job search with made-up companies and sample data. Look around freely;
      changes and AI actions are turned off here.
    </div>
  );
}
