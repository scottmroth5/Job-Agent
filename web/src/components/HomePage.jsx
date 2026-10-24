import PipelineButton from './PipelineButton.jsx';

// Simple line illustrations for the tiles (inline SVG: nothing to download, and they follow the text color).
const ICONS = {
  jobs: (
    <>
      <rect x="6" y="14" width="36" height="24" rx="4" />
      <path d="M17 14v-3a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v3" />
      <path d="M6 24h36" />
      <path d="M21 24v4h6v-4" />
    </>
  ),
  inbox: (
    <>
      <rect x="6" y="11" width="36" height="26" rx="4" />
      <path d="M7 13l17 13 17-13" />
    </>
  ),
  funnel: (
    <>
      <path d="M7 10h34l-13 15v11l-8 4V25z" />
      <path d="M11 15h26" />
    </>
  ),
  activity: (
    <>
      <path d="M5 26h9l4-10 6 20 5-14 3 4h11" />
    </>
  ),
  admin: (
    <>
      <circle cx="24" cy="24" r="6" />
      <path d="M24 6v6M24 36v6M6 24h6M36 24h6M11.3 11.3l4.2 4.2M32.5 32.5l4.2 4.2M11.3 36.7l4.2-4.2M32.5 15.5l4.2-4.2" />
    </>
  ),
  add: (
    <>
      <circle cx="24" cy="24" r="17" />
      <path d="M24 16v16M16 24h16" />
    </>
  ),
};

function Icon({ name }) {
  return (
    <svg className="tile-icon" viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

function Tile({ href, onClick, icon, title, stat, alert }) {
  const body = (
    <>
      <span className={`tile-art t-${icon}`}>
        <Icon name={icon} />
      </span>
      <span className="tile-title">{title}</span>
      {stat && <span className={`tile-stat${alert ? ' alert' : ''}`}>{stat}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className="tile" onClick={onClick}>
      {body}
    </button>
  ) : (
    <a className="tile" href={href}>
      {body}
    </a>
  );
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The start page: a tile for each screen with what needs attention, the pipeline, and this month's Claude budget. */
export default function HomePage({ summary, demo, onAddJob, onPipelineFinished }) {
  const s = summary;
  const budget = s?.budget;
  return (
    <div className="home">
      <div className="tiles">
        <Tile href="#/jobs" icon="jobs" title="Jobs" stat={s ? `${plural(s.needsAction ?? 0, 'needs', 'need')} action` : null} alert={s?.needsAction > 0} />
        <Tile href="#/inbox" icon="inbox" title="Inbox" stat={s ? (s.inboxNeedsReview ? `${plural(s.inboxNeedsReview, 'email')} to review` : 'All caught up') : null} alert={s?.inboxNeedsReview > 0} />
        <Tile href="#/funnel" icon="funnel" title="Funnel" stat={s ? `${s.inProgress ?? 0} in progress` : null} />
        <Tile href="#/activity" icon="activity" title="Activity" stat="Runs and their output" />
        <Tile href="#/admin" icon="admin" title="Admin" stat="Prompts, lists, spending" />
        {!demo && <Tile onClick={onAddJob} icon="add" title="Add a job" stat="Link or description" />}
      </div>

      {!demo && (
        <section className="home-card">
          <PipelineButton onFinished={onPipelineFinished} />
        </section>
      )}

      {budget && (
        <a className="home-card budget-card" href="#/admin/spending">
          <span className="budget-line">
            <span>Claude this month</span>
            <span className={`budget ${budget.level}`}>
              ${budget.spentUsd.toFixed(2)} of ${budget.limitUsd.toFixed(0)}
            </span>
          </span>
          <span className="meter">
            <span className={`fill ${budget.level}`} style={{ width: `${Math.min(100, Math.round((budget.spentUsd / budget.limitUsd) * 100))}%` }} />
          </span>
          {budget.level === 'over' && <span className="small budget over">Used up: Claude calls are paused until the 1st or until you raise it.</span>}
        </a>
      )}
    </div>
  );
}
