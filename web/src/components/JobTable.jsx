import { useMemo, useState } from 'react';
import { STATUS_LABELS, payText, hoursText, annualText, scoreClass, PAY_FROM } from '../format.js';

const COLUMNS = [
  { key: 'score', label: 'Score', get: (j) => j.score ?? -1 },
  { key: 'title', label: 'Role', get: (j) => j.title.toLowerCase() },
  { key: 'company', label: 'Company', get: (j) => j.company.toLowerCase() },
  { key: 'source', label: 'Source', get: (j) => j.source ?? '' },
  { key: 'location', label: 'Location', get: (j) => j.location ?? '' },
  { key: 'pay', label: 'Pay', get: (j) => j.annualized?.mid ?? j.pay?.min ?? -1 },
  { key: 'discoveredOn', label: 'Discovered', get: (j) => j.discoveredOn ?? '' },
  { key: 'status', label: 'Status', get: (j) => j.status },
  { key: 'appliedOn', label: 'Applied', get: (j) => j.appliedOn ?? '' },
  { key: 'letter', label: 'Letter', get: (j) => (j.letter ? (j.letter.flags.length ? 1 : 2) : 0) },
];

function LetterCell({ letter }) {
  if (!letter) return <span className="muted">none</span>;
  if (letter.flags.length) return <span className="badge warn" title={letter.flags.join('; ')}>review</span>;
  return <span className="badge ok">ready</span>;
}

export default function JobTable({ jobs, loading, onOpen, selectedId, stackable, stack, onToggleStack }) {
  const [sort, setSort] = useState({ key: 'score', dir: -1 });
  const columns = COLUMNS;

  const sorted = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sort.key) ?? COLUMNS[0];
    return [...jobs].sort((a, b) => {
      const x = col.get(a);
      const y = col.get(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [jobs, sort]);

  // Scores and dates sort newest/highest first on the first click.
  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : ['score', 'discoveredOn', 'appliedOn'].includes(key) ? -1 : 1 }));

  if (!loading && jobs.length === 0) return <div className="empty">No jobs match these filters.</div>;

  return (
    <div className="table-wrap">
      <table className="jobs">
        <thead>
          <tr>
            {stackable && <th aria-label="Add to stack" />}
            {columns.map((c) => (
              <th key={c.key} onClick={() => toggleSort(c.key)} className="sortable" aria-sort={sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                {c.label}
                {sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((j) => (
            <tr key={j.id} className={[j.id === selectedId && 'selected', j.awaitingDescription && 'needs-desc'].filter(Boolean).join(' ')} onClick={() => onOpen(j.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(j.id)}>
              {stackable && (
                <td className="stack-cell" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label="Include in stack" checked={stack.includes(j.id)} onChange={() => onToggleStack(j.id)} />
                </td>
              )}
              {columns.map((c) => (
                <td key={c.key} data-label={c.label} className={`col-${c.key}`}>
                  {c.key === 'score' && (
                    <span className={scoreClass(j.score)}>
                      {j.score ?? '–'}
                      {j.fit && <span className="fit"> {j.fit}</span>}
                    </span>
                  )}
                  {c.key === 'title' && (
                    <>
                      <span className="role">{j.title}</span>
                      {j.track === 'fractional' && <span className="badge frac">fractional</span>}
                      {j.hasCopies && <span className="badge warn" title="Another saved job has the same company and title; open it to compare">possible duplicate</span>}
                      {j.awaitingDescription ? (
                        <span className="badge warn" title="Scored from the title alone; paste the description, then Re-score">needs description</span>
                      ) : (
                        j.needsDescription && <span className="badge muted">no description</span>
                      )}
                    </>
                  )}
                  {c.key === 'company' && j.company}
                  {c.key === 'source' && <span className="muted">{j.source}</span>}
                  {c.key === 'location' && <span className="muted">{j.location ?? ''}</span>}
                  {c.key === 'pay' && j.pay && (
                    <span className="terms" title={`${PAY_FROM[j.pay.from] ?? ''}${j.pay.text ? `: ${j.pay.text}` : ''}`}>
                      {[payText(j), hoursText(j)].filter(Boolean).join(' · ')}
                      {j.annualized && j.pay.unit !== 'year' && <span className="muted small"> ≈ {annualText(j.annualized)}</span>}
                    </span>
                  )}
                  {c.key === 'status' && <span className={`status s-${j.status}`}>{STATUS_LABELS[j.status]}</span>}
                  {c.key === 'discoveredOn' && <span className="muted nowrap">{j.discoveredOn ?? ''}</span>}
                  {c.key === 'appliedOn' && <span className="muted">{j.appliedOn ?? ''}</span>}
                  {c.key === 'letter' && <LetterCell letter={j.letter} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {loading && <div className="muted small loading">Loading…</div>}
    </div>
  );
}
