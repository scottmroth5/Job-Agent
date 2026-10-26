// The dashboard pictures in web/public/dash (160 px PNGs): Home tiles, the Home link, and the job panel's section headings.
export const DASH = {
  home: 'home',
  jobs: 'job-listings',
  inbox: 'files',
  funnel: 'application-pipeline',
  activity: 'search',
  admin: 'ai-tools',
  settings: 'settings',
  help: 'notes',
  score: 'match-score',
  letter: 'cover-letters',
  resume: 'resume',
  prep: 'interviews',
  notes: 'notes',
  attachments: 'files',
};

export function DashIcon({ name, className = 'dash-icon' }) {
  return <img src={`/dash/${DASH[name]}.png`} alt="" aria-hidden="true" className={className} draggable="false" />;
}
