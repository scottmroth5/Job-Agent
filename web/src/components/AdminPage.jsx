import { useEffect, useState } from 'react';
import ListsAdmin from './ListsAdmin.jsx';
import SpendingAdmin from './SpendingAdmin.jsx';
import UsersAdmin from './UsersAdmin.jsx';
import { useDemo } from '../demo.jsx';
import { isAdmin, isOwner, useMe } from '../me.jsx';

// [key, label, who sees it]: the lists are shared by everyone, so only the owner edits them; Users is for admins.
// Prompts moved to Settings (each user's own); an old #/admin/prompts link is sent there.
const SECTIONS = [
  ['lists', 'Lists', (me, demo) => isOwner(me) && !demo],
  ['spending', 'Spending', (me, demo) => isAdmin(me) && !demo],
  ['users', 'Users', (me, demo) => isAdmin(me) && !demo],
];
const sectionFromHash = () => {
  const s = /^#\/admin\/(\w+)/.exec(window.location.hash)?.[1];
  return SECTIONS.some(([k]) => k === s) ? s : null;
};

export default function AdminPage() {
  const me = useMe();
  const demo = useDemo();
  const sections = SECTIONS.filter(([, , shown]) => shown(me, demo));
  const [asked, setSectionState] = useState(sectionFromHash);
  // The section in the address, once this person may see it (who they are arrives just after the page loads).
  const section = sections.some(([k]) => k === asked) ? asked : sections[0]?.[0];
  const setSection = (s) => {
    setSectionState(s);
    window.history.replaceState(null, '', `#/admin/${s}`);
  };
  useEffect(() => {
    if (/^#\/admin\/prompts/.test(window.location.hash)) window.location.replace('#/settings/prompts');
    const onHash = () => setSectionState(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Admin holds only app-wide controls (accounts, the shared lists, the cap on the owner's key): not in the demo.
  if (!sections.length) {
    return <p className="muted">Admin is where the app's owner manages accounts, the shared lists, and the monthly AI budget. Your own settings are under Settings.</p>;
  }

  return (
    <>
      <div className="segmented admin-sections" role="tablist" aria-label="Admin">
        {sections.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={section === k} className={section === k ? 'on' : ''} onClick={() => setSection(k)}>
            {l}
          </button>
        ))}
      </div>
      {section === 'users' ? (
        <UsersAdmin />
      ) : section === 'lists' ? (
        <ListsAdmin />
      ) : section === 'spending' ? (
        <SpendingAdmin />
      ) : null}
    </>
  );
}
