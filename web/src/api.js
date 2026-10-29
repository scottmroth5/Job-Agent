// Thin client for the Job Agent API (see /api/openapi.json).

const OFFLINE = 'Cannot reach the Job Agent server. Start it with npm run ui, then try again.';

// The demo (AUTH_MODE=demo; App calls setDemoMode from /api/me). Every change is stopped here, before anything is sent:
// it rejects with DEMO_NOT_SAVED and announces it (the demo-blocked event, shown by App's DemoNotice). AI actions answer
// with canned samples from demo/samples.js, loaded only in the demo, through local stand-in tasks; no model is called.
// The server refuses changes in the demo too (server/auth.js), so this is for clarity, not protection.
let demoMode = false;
export const setDemoMode = (on) => {
  demoMode = Boolean(on);
};
export const DEMO_NOT_SAVED = 'Demo: nothing was saved. In your own account this would save the change.';
const DEMO_ALLOWED = /^\/api\/prompts\/[a-z-]+\/preview$/; // fills a draft prompt and writes nothing
const demoSamples = () => import('../../demo/samples.js');
const demoTasks = new Map();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function demoBlocked() {
  window.dispatchEvent(new CustomEvent('demo-blocked'));
  return Object.assign(new Error(DEMO_NOT_SAVED), { demo: true });
}
/** A finished stand-in task for a demo AI action: the steps the real one shows, and its sample result. */
function demoTask(kind, steps, result) {
  const id = `demo-${demoTasks.size + 1}`;
  const at = new Date().toISOString();
  demoTasks.set(id, { id: null, kind, status: 'done', steps: steps.map((message) => ({ at, message })), log: [], result: { ...result, sample: true }, error: null });
  return { taskId: id };
}

/** fetch, with the browser's bare "Failed to fetch" turned into a message that says what to do. */
async function send(path, init) {
  if (demoMode && init?.method && !['GET', 'HEAD'].includes(init.method) && !DEMO_ALLOWED.test(path.split('?')[0])) throw demoBlocked();
  try {
    return await fetch(path, init);
  } catch {
    throw new Error(OFFLINE);
  }
}

async function request(method, path, body) {
  const res = await send(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // Signed out (google mode): go to sign-in and come back to this screen afterwards.
  if (res.status === 401) {
    window.location.href = `/auth/login?next=${encodeURIComponent(`/${window.location.hash}`)}`;
    throw new Error('Sign in required.');
  }
  const data = await res.json().catch(() => ({}));
  // An account that is no longer usable (pending, not approved, removed): the page itself says what to do.
  if (res.status === 403 && data.account) {
    window.location.href = '/';
    throw new Error(data.error ?? 'No access.');
  }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Sends a file as the raw request body with its name in X-Filename (the server reads its type from the bytes). */
async function uploadFile(path, file, limit, method = 'POST') {
  const res = await send(path, {
    method,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
  if (res.status === 401) {
    window.location.href = `/auth/login?next=${encodeURIComponent(`/${window.location.hash}`)}`;
    throw new Error('Sign in required.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 413 ? `${file.name} is over the ${limit} limit.` : data.error ?? `Upload failed (${res.status})`);
  return data;
}

export const api = {
  me: () => request('GET', '/api/me'),
  account: () => request('GET', '/api/account'),
  saveClaudeKey: (key) => request('PUT', '/api/account/claude-key', { key }),
  removeClaudeKey: () => request('DELETE', '/api/account/claude-key'),
  accountSearch: () => request('GET', '/api/account/search'),
  saveAccountSearch: (body) => request('PUT', '/api/account/search', body),
  saveAccountProfile: (text) => request('PUT', '/api/account/profile', { text }),
  // The knowledge doc from a document: its text, not saved.
  profileFromFile: (file) => uploadFile('/api/account/profile/from-file', file, '5 MB'),
  // A job's cover letter versions, revising with Claude, and saving or restoring a version (server/letter-routes.js).
  letters: (id) => request('GET', `/api/postings/${id}/letters`),
  followUps: () => request('GET', '/api/follow-ups'),
  setStaleDays: (staleDays) => request('PUT', '/api/follow-ups/settings', { staleDays }),
  staleApplications: () => request('GET', '/api/follow-ups/stale'),
  closeStale: () => request('POST', '/api/follow-ups/close-stale'),
  closeNoResponse: (id) => request('POST', `/api/postings/${id}/close-no-response`),
  findContact: async (id) => {
    if (!demoMode) return request('POST', `/api/postings/${id}/find-contact`);
    const { markdown } = await api.findContactSample(id);
    return demoTask('find-contact', ['Searching for the hiring manager and a recruiter (about a minute)', 'Sample answer ready (demo: no AI, nothing saved)'], { markdown });
  },
  findContactSample: (id) => request('GET', `/api/postings/${id}/find-contact/sample`), // the demo's canned answer
  excludedSites: () => request('GET', '/api/excluded-sites'),
  skipSite: (site, note = '') => request('POST', '/api/excluded-sites', { site, note }),
  setSiteNote: (site, note) => request('PATCH', `/api/excluded-sites/${encodeURIComponent(site)}`, { note }),
  unskipSite: (site) => request('DELETE', `/api/excluded-sites/${encodeURIComponent(site)}`),
  removeSiteJobs: (site) => request('POST', `/api/excluded-sites/${encodeURIComponent(site)}/remove-jobs`),
  reviseLetter: async (id, body) => {
    if (!demoMode) return request('POST', `/api/postings/${id}/letter/revise`, body);
    const [{ sampleRevision }, job] = await Promise.all([demoSamples(), api.get(id), pause(1200)]);
    return sampleRevision({ ...body, company: job.company, title: job.title });
  },
  saveLetter: (id, content, source) => request('POST', `/api/postings/${id}/letter`, { content, source }),
  restoreLetter: (id, versionId) => request('POST', `/api/postings/${id}/letter/restore`, { versionId }),
  letterFromFile: (id, file) => uploadFile(`/api/postings/${id}/letter/from-file`, file, '5 MB'),
  // Settings > Resumes (server/resume-routes.js).
  resumes: () => request('GET', '/api/resumes'),
  uploadResume: (file) => uploadFile('/api/resumes', file, '5 MB'),
  replaceResume: (id, file) => uploadFile(`/api/resumes/${id}/file`, file, '5 MB'),
  updateResume: (id, patch) => request('PATCH', `/api/resumes/${id}`, patch),
  deleteResume: (id) => request('DELETE', `/api/resumes/${id}`),
  setAccountSchedule: (on) => request('PUT', '/api/account/schedule', { on }),
  users: () => request('GET', '/api/admin/users'),
  decideUser: (id, decision) => request('POST', `/api/admin/users/${id}/${decision}`),
  setUserAi: (id, source, capUsd = null, confirmEmail = undefined) => request('PUT', `/api/admin/users/${id}/ai`, { source, capUsd, ...(confirmEmail ? { confirmEmail } : {}) }),
  sendFeedback: (body, page) => request('POST', '/api/feedback', { body, page }),
  pauseAccount: () => request('POST', '/api/account/pause'),
  help: () => request('GET', '/api/help'),
  buildDraft: async (payload) => {
    if (!demoMode) return request('POST', '/api/account/draft', payload);
    const [{ sampleDraft }] = await Promise.all([demoSamples(), pause(1500)]);
    return sampleDraft();
  },
  askHelp: async (question) => {
    if (!demoMode) return request('POST', '/api/help/ask', { question });
    const [{ sampleHelpAnswer }, guides] = await Promise.all([demoSamples(), api.help(), pause(800)]);
    return sampleHelpAnswer(question, guides);
  },
  setTimeZone: (timeZone) => request('PUT', '/api/account/timezone', { timeZone }),
  resumeAccount: () => request('POST', '/api/account/resume'),
  deleteAccount: (confirmEmail) => request('POST', '/api/account/delete', { confirmEmail }),
  deleteUser: (id, confirmEmail) => request('POST', `/api/admin/users/${id}/delete`, { confirmEmail }),
  adminFeedback: () => request('GET', '/api/admin/feedback'),
  feedbackDone: (id) => request('POST', `/api/admin/feedback/${id}/done`),
  /** Sends the file as the raw body with its name and type in headers (no multipart). */
  uploadAttachment: async (jobId, file) => {
    const res = await send(`/api/postings/${jobId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), 'X-File-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (res.status === 401) {
      window.location.href = `/auth/login?next=${encodeURIComponent(`/${window.location.hash}`)}`;
      throw new Error('Sign in required.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 413 ? `${file.name} is over the 25 MB limit.` : data.error ?? `Upload failed (${res.status})`);
    return data;
  },
  deleteAttachment: async (id) => {
    const res = await send(`/api/attachments/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
  },
  signOut: () => fetch('/auth/logout', { method: 'POST' }),
  summary: () => request('GET', '/api/summary'),
  saveLayout: (area, order) => request('PUT', `/api/layout/${area}`, { order }),
  list: (filters) => {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '' && v != null && v !== false));
    return request('GET', `/api/postings?${q}`);
  },
  get: (id) => request('GET', `/api/postings/${id}`),
  update: (id, patch) => request('PATCH', `/api/postings/${id}`, patch),
  add: (job) => request('POST', '/api/postings', job),
  action: async (id, action) => {
    // In the demo the AI actions answer with samples; Refetch posting changes data, so it is stopped like any change.
    if (!demoMode || !['score', 'write-materials', 'regenerate'].includes(action)) return request('POST', `/api/postings/${id}/actions/${action}`);
    const [m, job] = await Promise.all([demoSamples(), api.get(id), pause(1200)]);
    if (action === 'score') return demoTask(action, ['Reading the posting', 'Scoring with Sonnet 5.5', 'Sample score ready (demo: no AI, nothing saved)'], { score: m.sampleScore(job) });
    return demoTask(action, ['Writing resume tweaks', 'Writing the cover letter', 'Sample ready (demo: no AI, nothing saved)'], { letter: m.sampleLetter(job, { regenerate: action === 'regenerate' }), tweaks: m.sampleTweaks(job) });
  },
  addNote: (id, body) => request('POST', `/api/postings/${id}/notes`, { body }),
  updateNote: (noteId, body) => request('PATCH', `/api/notes/${noteId}`, { body }),
  deleteNote: async (noteId) => {
    const res = await send(`/api/notes/${noteId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
  },
  startPrep: async (id, body) => {
    if (!demoMode) return request('POST', `/api/postings/${id}/meeting-prep`, body);
    const [{ samplePrep }, job] = await Promise.all([demoSamples(), api.get(id), pause(1500)]);
    const steps = [body.research ? 'Researching the people and the company, then writing the prep (a few minutes)' : 'Writing the prep', 'Sample prep ready (demo: no AI, nothing saved)'];
    return demoTask('meeting-prep', steps, { prep: { id: 'demo-sample', content: samplePrep(job, body), createdAt: new Date().toISOString(), model: 'a canned sample (no AI)', research: false, webSearches: 0, costUsd: null } });
  },
  prep: (prepId) => request('GET', `/api/meeting-preps/${prepId}`),
  deletePrep: async (prepId) => {
    const res = await send(`/api/meeting-preps/${prepId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
  },
  task: (id) => (demoTasks.has(id) ? Promise.resolve(demoTasks.get(id)) : request('GET', `/api/tasks/${id}`)),
  tasks: () => request('GET', '/api/tasks'),
  taskLog: (id, from = 0) => request('GET', `/api/tasks/${id}/log?from=${from}`),
  pipeline: () => request('GET', '/api/pipeline'),
  runPipeline: () => request('POST', '/api/pipeline/run'),
  inbox: () => request('GET', '/api/inbox'),
  checkInbox: () => request('POST', '/api/inbox/check'),
  reviewEmail: (id, choice, postingId) => request('POST', `/api/inbox/emails/${id}/review`, { choice, ...(postingId ? { postingId } : {}) }),
  closeReminder: (id, status) => request('PATCH', `/api/inbox/reminders/${id}`, { status }),
  funnel: (days, track) => request('GET', `/api/funnel?days=${days}${track && track !== 'all' ? `&track=${track}` : ''}`),
  lookups: () => request('GET', '/api/lookups'),
  budget: () => request('GET', '/api/spending'),
  setBudget: (limitUsd) => request('PUT', '/api/admin/budget', { limitUsd }),
  adminLookups: () => request('GET', '/api/admin/lookups'),
  addLookup: (list, value) => request('POST', `/api/admin/lookups/${list}`, value),
  updateLookup: (list, id, patch) => request('PATCH', `/api/admin/lookups/${list}/${id}`, patch),
  setLookupRole: (list, role, valueId) => request('PUT', `/api/admin/lookups/${list}/roles`, { role, valueId }),
  prompts: () => request('GET', '/api/prompts'),
  prompt: (name) => request('GET', `/api/prompts/${name}`),
  savePrompt: (name, template, note) => request('PUT', `/api/prompts/${name}`, { template, ...(note ? { note } : {}) }),
  restorePrompt: (name, versionId) => request('POST', `/api/prompts/${name}/restore`, { versionId }),
  previewPrompt: (name, template, postingId) =>
    request('POST', `/api/prompts/${name}/preview`, { template, ...(postingId ? { postingId: Number(postingId) } : {}) }),
};

/** Polls a background task, reporting each update, until it finishes. Resolves with the final task. */
export async function followTask(taskId, onUpdate) {
  for (;;) {
    const task = await api.task(taskId);
    onUpdate?.(task);
    if (task.status !== 'running') return task;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
