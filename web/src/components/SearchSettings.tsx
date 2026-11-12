import { useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { api } from '../api.ts';
import type { ApiBody, ApiResponse } from '../api.ts';

type SearchData = ApiResponse<'GET /api/account/search'>;
type Draft = ApiResponse<'POST /api/account/draft'>;
/** The search form: every field as the text in its box (lists one item per line). */
type SearchForm = Record<string, string | number>;
/** One of the knowledge doc's sections (agents/knowledge-sections.ts). */
type Section = { n: number; title: string; hint?: string };
import DraftBuilder from './DraftBuilder.tsx';
import KnowledgeVersions from './KnowledgeVersions.tsx';
import { useDemo } from '../demo.tsx';

// Lists are edited one item per line.
const lines = (v: string[] | null | undefined) => (v ?? []).join('\n');
const fromLines = (s: unknown) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);

const LIST_FIELDS: Array<[key: string, label: string, hint: string]> = [
  ['terms', 'Job titles to search for', 'One per line, e.g. VP Engineering'],
  ['relevantTitleKeywords', 'Words a relevant title contains', 'e.g. engineering, technology, cto'],
  ['noiseTitleKeywords', 'Words that rule a title out (optional)', 'e.g. intern, sales'],
  ['homeLocations', 'Where you can work in person', 'Cities and areas, e.g. Anytown, ST; remote jobs are always included'],
  ['fractionalTerms', 'Fractional or part-time titles (optional)', 'e.g. Fractional CTO'],
];

// Which of the knowledge doc's seven sections the text has, by heading (agents/knowledge-sections.ts sectionCheck does the
// same on the server). A numbered heading counts by its number whatever its title ("SECTION 5: TARGET ROLES"), since the
// prompts name sections by number; an unnumbered one by the standard title. Plain "1. ..." list items do not count.
const norm = (t: unknown) => String(t).toLowerCase().replace(/[^a-z]+/g, ' ').trim();
const headingNumber = (l: string) => {
  const m = /^section\s+(\d+)\b/i.exec(l) ?? /^#+\s*(?:section\s+)?(\d+)\s*[.:)\-]/i.exec(l);
  return m ? Number(m[1]) : null;
};
function sectionsIn(text: string | null | undefined, sections: Section[]) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l.length <= 80);
  const numbers = new Set(lines.map(headingNumber).filter((n) => n != null));
  const titles = new Set(lines.filter((l) => l.length <= 60).map((l) => norm(l.replace(/^#+\s*/, '').replace(/^section\s*/i, '').replace(/^\d+\s*[.:)\-]?\s*/, ''))));
  return sections.map((sec) => ({ ...sec, found: numbers.has(sec.n) || titles.has(norm(sec.title)) }));
}

/** The seven sections as chips (present or missing), and a button that starts from the template or adds what is missing. */
function SectionChecklist({ sections, text, template, readOnly = false, onChange }: { sections: Section[]; text: string; template: string; readOnly?: boolean; onChange: (text: string) => void }) {
  if (!sections.length) return null;
  const check = sectionsIn(text, sections);
  const missing = check.filter((c) => !c.found);
  const empty = !String(text ?? '').trim();
  const addMissing = () => {
    const blocks = template.split('\n\n').filter((b) => missing.some((m) => b.startsWith(`## ${m.n}. `)));
    onChange(empty ? template : `${String(text).trimEnd()}\n\n${blocks.join('\n\n')}`);
  };
  return (
    <div className="section-check">
      <ul className="section-chips" aria-label="Sections in your knowledge doc">
        {check.map((c) => (
          <li key={c.n} className={`badge ${c.found ? 'ok' : 'muted'}`} title={c.hint}>
            <span aria-hidden="true">{c.found ? '✓ ' : ''}</span>
            {c.n}. {c.title}
            <span className="sr-only">{c.found ? ' (present)' : ' (missing)'}</span>
          </li>
        ))}
      </ul>
      {!readOnly && missing.length > 0 && (
        <button type="button" onClick={addMissing}>
          {empty ? 'Start from the template' : `Add the ${missing.length === 1 ? 'missing section' : `${missing.length} missing sections`}`}
        </button>
      )}
    </div>
  );
}

/**
 * Settings: the knowledge doc (everyone's, the owner's too) and, for everyone but the owner, the search (when it runs
 * is under Automatic runs, AutomationSettings.tsx).
 * The owner's search settings live in their settings file.
 */
export default function SearchSettings() {
  const demo = useDemo(); // the demo shows the sample candidate's, read-only
  const [data, setData] = useState<SearchData | null>(null);
  const [form, setForm] = useState<SearchForm | null>(null);
  const [profile, setProfile] = useState('');
  const [profileSource, setProfileSource] = useState<ApiBody<'PUT /api/account/profile'>['source']>('typed'); // how the text in the box came: typed, file, or draft
  const [versionsKey, setVersionsKey] = useState(0); // reloads the versions after a save or restore
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const show = (d: SearchData) => {
    setData(d);
    if (d.owner) {
      setProfile(d.profile ?? ''); // the owner's search settings stay in their settings file; the knowledge doc lives here
      return;
    }
    const c = d.config;
    setForm({
      name: c.candidate.name, signoffName: c.candidate.signoffName, contactLine: c.candidate.contactLine, linkedin: c.candidate.linkedin, website: c.candidate.website ?? '', github: c.candidate.github ?? '',
      homeAreaLabel: c.search.homeAreaLabel ?? '', localSearchLocation: c.search.localSearchLocation ?? '',
      ...Object.fromEntries(LIST_FIELDS.map(([k]) => [k, lines(c.search[k])])),
      targetLow: c.fractional?.targetAnnual?.[0] ?? '', targetHigh: c.fractional?.targetAnnual?.[1] ?? '',
    });
    setProfile(d.profile);
  };
  useEffect(() => {
    api.accountSearch().then(show, (err) => setError((err as Error).message));
  }, []);

  const run = async (action: () => Promise<SearchData>, done: string) => {
    setError(null);
    setNote(null);
    try {
      show(await action());
      setNote(done);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!data) return error ? <div className="error">{error}</div> : null;
  const owner = data.owner;
  const f = form as SearchForm; // set with data for everyone but the owner, whose screen never reads it
  const set = (k: string) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...f, [k]: e.target.value });
  // A draft fills the forms (never saves): the user reviews it and saves each part.
  const useDraftSearch = (d: Draft) => {
    setForm({
      ...f,
      name: d.candidate.name || f.name, signoffName: d.candidate.signoffName || f.signoffName,
      contactLine: d.candidate.contactLine || f.contactLine, linkedin: d.candidate.linkedin || f.linkedin,
      terms: lines(d.search.terms), relevantTitleKeywords: lines(d.search.relevantTitleKeywords), noiseTitleKeywords: lines(d.search.noiseTitleKeywords),
      homeLocations: lines(d.search.homeLocations), fractionalTerms: lines(d.search.fractionalTerms),
    });
    setNote('The draft search is in the form below: check it, then Save search settings.');
  };
  const useDraftProfile = (text: string) => {
    setProfile(text);
    setProfileSource('draft');
    setNote('The draft is in your knowledge doc: edit it, then Save.');
  };
  const saveSearch = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () =>
        api.saveAccountSearch({
          candidate: { name: f.name, signoffName: f.signoffName, contactLine: f.contactLine, linkedin: f.linkedin, website: f.website, github: f.github },
          search: { homeAreaLabel: f.homeAreaLabel, localSearchLocation: f.localSearchLocation, ...Object.fromEntries(LIST_FIELDS.map(([k]) => [k, fromLines(f[k])])) },
          fractional: { targetAnnual: [Number(f.targetLow), Number(f.targetHigh)] },
        }),
      'Search settings saved.',
    );
  };
  const chars = profile.trim().length;
  // The required fields still empty, by their labels here.
  const missing = LIST_FIELDS.filter(([k]) => (data.problems ?? []).some((p: string) => p.startsWith(`search.${k} `))).map(([, label]) => label);
  return (
    <>
      <section className="home-card">
        <h2>Your knowledge doc</h2>
        <p className="muted small">
          Everything the AI knows about you: every score, cover letter, resume tweak, and meeting prep is written from it. It has seven sections; scoring
          weighs <b>5. Job Targets</b> most, and letters follow <b>6. Cover Letter Rules</b>. Start from the template, fill it from a document, or build a
          draft from your resume and LinkedIn profile. At least {data.profileChars.min} characters. <a href="#/help">Help</a>, <i>Writing your knowledge
          doc</i>, explains each section with full examples.
        </p>
        {demo && (
          <p className="warn-box small">A sample: the knowledge doc of Jordan, the demo's made-up candidate. Try Build a draft (a canned sample, no AI) or edit the text; nothing is saved here.</p>
        )}
          <>
            <div className="row">
              <label className="button file-button">
                Fill from a document
                <input
                  type="file"
                  accept=".pdf,.docx,.txt,.md"
                  className="sr-only"
                  onChange={async (ev) => {
                    const file = ev.target.files?.[0];
                    ev.target.value = '';
                    if (!file) return;
                    setError(null);
                    setNote(null);
                    try {
                      const { text } = await api.profileFromFile(file);
                      setProfile(text);
                      setProfileSource('file');
                      setNote(`Your knowledge doc now holds the text of ${file.name}: check it against the sections, then Save.`);
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                />
              </label>
              <span className="muted small">PDF, Word .docx, or text: its text replaces the box below for you to review.</span>
            </div>
            <DraftBuilder onUseProfile={useDraftProfile} onUseSearch={owner ? null : useDraftSearch} />
          </>
        <SectionChecklist sections={data.knowledgeSections ?? []} text={profile} template={data.knowledgeTemplate} onChange={setProfile} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.saveAccountProfile(profile, profileSource), 'Saved. The earlier version is kept under Versions.').then(() => {
              setProfileSource('typed');
              setVersionsKey((k) => k + 1);
            });
          }}
        >
          <textarea className="profile-text" rows={12} maxLength={data.profileChars.max} value={profile} onChange={(e) => setProfile(e.target.value)} />
          <div className="row demo-hide">
            <button className="primary" type="submit" disabled={profile === data.profile}>
              Save
            </button>
            <span className={`small ${chars < data.profileChars.min ? 'budget warn' : 'muted'}`}>{chars} characters</span>
            <a className="button" href="/api/account/profile.docx" download>
              Download Word
            </a>
          </div>
        </form>
        <KnowledgeVersions
          key={versionsKey}
          onRestored={(d) => {
            show(d);
            setVersionsKey((k) => k + 1);
            setNote('That version is your knowledge doc again (saved as a new version).');
          }}
        />
      </section>

      {owner ? (
        <section className="home-card">
          <h2>Your search</h2>
          <p className="muted">Your search settings come from data/config/job-search.json on the server.</p>
        </section>
      ) : (
      <section className="home-card">
        <h2>Your search</h2>
        {missing.length > 0 && <p className="warn-box">To run your pipeline, fill in: {missing.join('; ')}.</p>}
        {demo && <p className="muted small">Jordan's search: what the pipeline looks for. Try changing it; the demo saves nothing.</p>}
        <form className="search-form" onSubmit={saveSearch}>
          <fieldset className="bare">
          <div className="grid2">
            <label>Your name<input value={f.name} onChange={set('name')} /></label>
          </div>
          <p className="muted small">Your letter's name, contact details, links, and sign-off are under Cover letter header, below.</p>
          {LIST_FIELDS.map(([k, label, hint]) => (
            <label key={k}>
              {label}
              <textarea rows={3} value={f[k]} onChange={set(k)} placeholder={hint} />
            </label>
          ))}
          <div className="grid2">
            <label>Your area, in words (optional)<input value={f.homeAreaLabel} onChange={set('homeAreaLabel')} placeholder="the Anytown area" /></label>
            <label>LinkedIn search location (optional)<input value={f.localSearchLocation} onChange={set('localSearchLocation')} placeholder="Anytown Metropolitan Area" /></label>
            <label>Fractional target, low ($ a year)<input type="number" min="0" value={f.targetLow} onChange={set('targetLow')} /></label>
            <label>Fractional target, high ($ a year)<input type="number" min="0" value={f.targetHigh} onChange={set('targetHigh')} /></label>
          </div>
          <button className="primary demo-hide" type="submit">
            Save search settings
          </button>
          </fieldset>
        </form>
        <p className="muted small demo-hide">When your pipeline runs on its own (it uses your Claude key) is under Automatic runs, below. Your pipeline searches the free job sources; Google results and Google Docs are the owner's only for now. Letters and meeting preps are kept here in the app.</p>
      </section>
      )}
      {note && <p className="muted small">{note}</p>}
      {error && <div className="error">{error}</div>}
    </>
  );
}
