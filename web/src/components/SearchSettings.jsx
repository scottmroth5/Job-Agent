import { useEffect, useState } from 'react';
import { api } from '../api.js';
import DraftBuilder from './DraftBuilder.jsx';

// Lists are edited one item per line.
const lines = (v) => (v ?? []).join('\n');
const fromLines = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);

const LIST_FIELDS = [
  ['terms', 'Job titles to search for', 'One per line, e.g. VP Engineering'],
  ['relevantTitleKeywords', 'Words a relevant title contains', 'e.g. engineering, technology, cto'],
  ['noiseTitleKeywords', 'Words that rule a title out (optional)', 'e.g. intern, sales'],
  ['homeLocations', 'Where you can work in person', 'Cities and areas, e.g. Anytown, ST; remote jobs are always included'],
  ['fractionalTerms', 'Fractional or part-time titles (optional)', 'e.g. Fractional CTO'],
  ['excludedSites', 'Job sites to skip (optional)', 'Domains, e.g. example-jobs.com'],
];

/**
 * Settings > Your search: what the pipeline looks for, the facts about you that scoring and letters use, and whether
 * your pipeline runs on the schedule. The owner's live in their settings file and Google Doc instead.
 */
export default function SearchSettings() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [profile, setProfile] = useState('');
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const show = (d) => {
    setData(d);
    if (d.owner) return;
    const c = d.config;
    setForm({
      name: c.candidate.name, signoffName: c.candidate.signoffName, contactLine: c.candidate.contactLine, linkedin: c.candidate.linkedin,
      homeAreaLabel: c.search.homeAreaLabel ?? '', localSearchLocation: c.search.localSearchLocation ?? '',
      ...Object.fromEntries(LIST_FIELDS.map(([k]) => [k, lines(c.search[k])])),
      targetLow: c.fractional?.targetAnnual?.[0] ?? '', targetHigh: c.fractional?.targetAnnual?.[1] ?? '',
    });
    setProfile(d.profile);
  };
  useEffect(() => {
    api.accountSearch().then(show, (err) => setError(err.message));
  }, []);

  const run = async (action, done) => {
    setError(null);
    setNote(null);
    try {
      show(await action());
      setNote(done);
    } catch (err) {
      setError(err.message);
    }
  };

  if (!data) return error ? <div className="error">{error}</div> : null;
  if (data.owner) {
    return (
      <section className="home-card">
        <h2>Your search</h2>
        <p className="muted">Your search settings come from data/config/job-search.json, and the facts about you from your Google Doc.</p>
        <DraftBuilder owner />
      </section>
    );
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  // A draft fills the forms (never saves): the user reviews it and saves each part.
  const useDraftSearch = (d) => {
    setForm({
      ...form,
      name: d.candidate.name || form.name, signoffName: d.candidate.signoffName || form.signoffName,
      contactLine: d.candidate.contactLine || form.contactLine, linkedin: d.candidate.linkedin || form.linkedin,
      terms: lines(d.search.terms), relevantTitleKeywords: lines(d.search.relevantTitleKeywords), noiseTitleKeywords: lines(d.search.noiseTitleKeywords),
      homeLocations: lines(d.search.homeLocations), fractionalTerms: lines(d.search.fractionalTerms),
    });
    setNote('The draft search is in the form below: check it, then Save search settings.');
  };
  const useDraftProfile = (text) => {
    setProfile(text);
    setNote('The draft is in About you: edit it, then Save.');
  };
  const saveSearch = (e) => {
    e.preventDefault();
    run(
      () =>
        api.saveAccountSearch({
          candidate: { name: form.name, signoffName: form.signoffName, contactLine: form.contactLine, linkedin: form.linkedin },
          search: { homeAreaLabel: form.homeAreaLabel, localSearchLocation: form.localSearchLocation, ...Object.fromEntries(LIST_FIELDS.map(([k]) => [k, fromLines(form[k])])) },
          fractional: { targetAnnual: [Number(form.targetLow), Number(form.targetHigh)] },
        }),
      'Search settings saved.',
    );
  };
  const chars = profile.trim().length;
  // The required fields still empty, by their labels here.
  const missing = LIST_FIELDS.filter(([k]) => data.problems.some((p) => p.startsWith(`search.${k} `))).map(([, label]) => label);
  return (
    <>
      <section className="home-card">
        <h2>About you</h2>
        <p className="muted small">
          What scoring, letters, and meeting prep know about you: your experience, strengths, what you want next, and anything to avoid. Paste your
          resume and add notes, or build a draft from your materials. At least {data.profileChars.min} characters. Help has a template and examples.
        </p>
        <DraftBuilder onUseProfile={useDraftProfile} onUseSearch={useDraftSearch} />
        <form onSubmit={(e) => { e.preventDefault(); run(() => api.saveAccountProfile(profile), 'Saved.'); }}>
          <textarea className="profile-text" rows={12} maxLength={data.profileChars.max} value={profile} onChange={(e) => setProfile(e.target.value)} />
          <div className="row">
            <button className="primary" type="submit" disabled={profile === data.profile}>
              Save
            </button>
            <span className={`small ${chars < data.profileChars.min ? 'budget warn' : 'muted'}`}>{chars} characters</span>
          </div>
        </form>
      </section>

      <section className="home-card">
        <h2>Your search</h2>
        {missing.length > 0 && <p className="warn-box">To run your pipeline, fill in: {missing.join('; ')}.</p>}
        <form className="search-form" onSubmit={saveSearch}>
          <div className="grid2">
            <label>Your name<input value={form.name} onChange={set('name')} /></label>
            <label>Sign letters as<input value={form.signoffName} onChange={set('signoffName')} placeholder="Defaults to your name" /></label>
            <label>Contact line on letters<input value={form.contactLine} onChange={set('contactLine')} placeholder="City, ST | email | phone" /></label>
            <label>LinkedIn<input value={form.linkedin} onChange={set('linkedin')} placeholder="linkedin.com/in/…" /></label>
          </div>
          {LIST_FIELDS.map(([k, label, hint]) => (
            <label key={k}>
              {label}
              <textarea rows={3} value={form[k]} onChange={set(k)} placeholder={hint} />
            </label>
          ))}
          <div className="grid2">
            <label>Your area, in words (optional)<input value={form.homeAreaLabel} onChange={set('homeAreaLabel')} placeholder="the Anytown area" /></label>
            <label>LinkedIn search location (optional)<input value={form.localSearchLocation} onChange={set('localSearchLocation')} placeholder="Anytown Metropolitan Area" /></label>
            <label>Fractional target, low ($ a year)<input type="number" min="0" value={form.targetLow} onChange={set('targetLow')} /></label>
            <label>Fractional target, high ($ a year)<input type="number" min="0" value={form.targetHigh} onChange={set('targetHigh')} /></label>
          </div>
          <button className="primary" type="submit">
            Save search settings
          </button>
        </form>
        <label className="switch check-row">
          <input type="checkbox" checked={data.scheduled} onChange={(e) => run(() => api.setAccountSchedule(e.target.checked), e.target.checked ? 'Your pipeline will run on the schedule.' : 'Off the schedule.')} />
          Run my pipeline on the app's schedule too (it uses your Claude key)
        </label>
        <p className="muted small">Your pipeline searches the free job sources; Google results and Google Docs are the owner's only for now. Letters and meeting preps are kept here in the app.</p>
      </section>
      {note && <p className="muted small">{note}</p>}
      {error && <div className="error">{error}</div>}
    </>
  );
}
