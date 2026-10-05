import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLookups } from '../lookups.jsx';

const LIST_NAMES = { status: 'Status', stage: 'Stage', track: 'Track' };
const LIST_HELP = {
  status: 'Where each job stands. The group decides which filter shows it, whether it is archived automatically, and how the inbox moves it.',
  stage: 'Where a job sits in your workflow. The group decides whether scoring promotes from it, whether it counts as your working list, or whether it is archived.',
  track: 'The kind of role. Each track chooses its scoring prompt and whether pay and hours show.',
};
const PROMPTS = { score: 'Full-time scoring', 'score-fractional': 'Fractional scoring' };

function ValueRow({ list, v, first, last, groups, roleNames, onChange, busy }) {
  const [label, setLabel] = useState(v.label);
  useEffect(() => setLabel(v.label), [v.label]);
  return (
    <tr className={v.archived ? 'archived' : ''}>
      <td>
        <input
          value={label}
          aria-label="Label"
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label.trim() && label !== v.label && onChange({ label })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          disabled={busy}
        />
        <div className="muted small">
          ID <code>{v.id}</code>
          {v.origin === 'built_in' ? ' · built in' : ''}
          {roleNames.length ? ` · ${roleNames.join(', ')}` : ''}
        </div>
      </td>
      <td>
        {list === 'track' ? (
          <>
            <select value={v.settings.scorePrompt ?? 'score'} onChange={(e) => onChange({ settings: { scorePrompt: e.target.value } })} disabled={busy} aria-label="Scoring prompt">
              {Object.entries(PROMPTS).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
            <label className="switch small">
              <input type="checkbox" checked={Boolean(v.settings.terms)} onChange={(e) => onChange({ settings: { terms: e.target.checked } })} disabled={busy} />
              Pay and hours
            </label>
          </>
        ) : (
          <select value={v.group} onChange={(e) => onChange({ group: e.target.value })} disabled={busy} aria-label="Group">
            {groups.map((g) => (
              <option key={g.key} value={g.key}>{g.label}</option>
            ))}
          </select>
        )}
      </td>
      <td className="muted">{v.jobs ?? 0}</td>
      <td className="nowrap">
        <button className="icon" title="Move up" disabled={busy || first} onClick={() => onChange({ move: 'up' })}>↑</button>
        <button className="icon" title="Move down" disabled={busy || last} onClick={() => onChange({ move: 'down' })}>↓</button>{' '}
        {v.archived ? (
          <button disabled={busy} onClick={() => onChange({ archived: false })}>Restore</button>
        ) : (
          <button disabled={busy || roleNames.length > 0} title={roleNames.length ? 'Move its role to another value first' : 'Hide it from menus; jobs that have it keep it'} onClick={() => onChange({ archived: true })}>
            Archive
          </button>
        )}
      </td>
    </tr>
  );
}

// Admin > Lists: add, rename, regroup, reorder, archive, and restore status, stage, and track values.
export default function ListsAdmin() {
  const shared = useLookups();
  const [data, setData] = useState(null);
  const [list, setList] = useState('status');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [newLabel, setNewLabel] = useState('');
  const [newGroup, setNewGroup] = useState('');

  useEffect(() => {
    api.adminLookups().then(setData).catch((err) => setError(err.message));
  }, []);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      setData(await fn());
      shared.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="muted">{error ?? 'Loading…'}</div>;
  const values = data.lists[list];
  const groups = data.groups[list];
  const roles = data.roles[list];
  const roleDefs = data.roleDefinitions[list];
  const roleNamesOf = (id) => roleDefs.filter((r) => roles[r.role] === id).map((r) => r.label);
  const groupKey = newGroup || groups[0].key;

  return (
    <div className="lists-admin">
      <div className="segmented" role="tablist" aria-label="List">
        {Object.entries(LIST_NAMES).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={list === k} className={list === k ? 'on' : ''} onClick={() => setList(k)}>
            {l}
          </button>
        ))}
      </div>
      <p className="muted small">{LIST_HELP[list]} Values are archived, never deleted: a job keeps its value even after it is archived.</p>
      {error && <div className="error">{error}</div>}

      <table className="history lists-table">
        <thead>
          <tr>
            <th>Label</th>
            <th>{list === 'track' ? 'Settings' : 'Group'}</th>
            <th>Jobs</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {values.map((v, i) => (
            <ValueRow
              key={v.id}
              list={list}
              v={v}
              first={i === 0}
              last={i === values.length - 1}
              groups={groups}
              roleNames={roleNamesOf(v.id)}
              busy={busy}
              onChange={(patch) => run(() => api.updateLookup(list, v.id, patch))}
            />
          ))}
        </tbody>
      </table>

      <form
        className="row add-value"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newLabel.trim()) return;
          run(async () => {
            const r = await api.addLookup(list, { label: newLabel, ...(list === 'track' ? { settings: { scorePrompt: 'score', terms: false } } : { group: groupKey }) });
            setNewLabel('');
            return r;
          });
        }}
      >
        <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder={`New ${LIST_NAMES[list].toLowerCase()} label`} aria-label="New label" maxLength={60} disabled={busy} />
        {list !== 'track' && (
          <select value={groupKey} onChange={(e) => setNewGroup(e.target.value)} aria-label="Group for the new value" disabled={busy}>
            {groups.map((g) => (
              <option key={g.key} value={g.key}>{g.label}</option>
            ))}
          </select>
        )}
        <button className="primary" type="submit" disabled={busy || !newLabel.trim()}>Add</button>
      </form>
      {list !== 'track' && (
        <ul className="muted small group-help">
          {groups.map((g) => (
            <li key={g.key}>
              <b>{g.label}:</b> {g.help}
            </li>
          ))}
        </ul>
      )}

      <section className="roles">
        <h3>Roles</h3>
        {roleDefs.map((r) => (
          <label key={r.role}>
            {r.label}
            <select value={roles[r.role] ?? ''} onChange={(e) => run(() => api.setLookupRole(list, r.role, e.target.value))} disabled={busy}>
              {values
                .filter((v) => !v.archived && (!r.groups || r.groups.includes(v.group)))
                .map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
            </select>
          </label>
        ))}
      </section>
    </div>
  );
}
