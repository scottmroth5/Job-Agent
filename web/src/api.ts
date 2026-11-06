// Thin client for the Job Agent API (see /api/openapi.json). Each call names its route as web/src/api-types.ts keys it
// ("METHOD /api/path"), generated from the route schemas: request bodies are checked against them, and so is every
// response the schema declares in full. A response schema that is only "an object" gives its fields no types (ApiResponse).
import { changeFeature, sampled, track } from './analytics.ts';
import type { ApiOperations, ApiRoute } from './api-types.ts';

type Op<R extends ApiRoute> = ApiOperations[R];
export type ApiBody<R extends ApiRoute> = Op<R>['body'];
// The one any for API responses: an open response schema ({ type: 'object' } with any fields) says nothing about its
// fields, so the page reads them untyped, as it did in JavaScript. Tighten the route's response schema to type them.
type Loose = any; // the reason is above
/** A response type with every open object in it (at any depth) as Loose, and everything the schema declares kept. */
type Loosen<T> = unknown extends T
  ? Loose
  : T extends ReadonlyArray<infer I>
    ? Array<Loosen<I>>
    : T extends object
      ? string extends keyof T
        ? Loose
        : { [K in keyof T]: Loosen<T[K]> }
      : T;
export type ApiResponse<R extends ApiRoute> = Loosen<Op<R>['response']>;

const OFFLINE = 'Cannot reach the Job Agent server. Start it with npm run ui, then try again.';

// The demo (AUTH_MODE=demo; App calls setDemoMode from /api/me). Every change is stopped here, before anything is sent:
// it rejects with DEMO_NOT_SAVED and announces it (the demo-blocked event, shown by App's DemoNotice). AI actions answer
// with canned samples from demo/samples.ts, loaded only in the demo, through local stand-in tasks; no model is called.
// The server refuses changes in the demo too (server/auth.ts), so this is for clarity, not protection.
let demoMode = false;
export const setDemoMode = (on: unknown) => {
  demoMode = Boolean(on);
};
export const DEMO_NOT_SAVED = 'Demo: nothing was saved. In your own account this would save the change.';
const DEMO_ALLOWED = /^\/api\/prompts\/[a-z-]+\/preview$/; // fills a draft prompt and writes nothing
const demoSamples = () => import('../../demo/samples.ts');

/** A background task as GET /api/tasks/:id returns it (server/tasks.ts), or a demo stand-in. */
export interface Task {
  id: string | null;
  kind: string;
  status: string;
  steps: Array<{ at: string; message: string }>;
  log: unknown[];
  result: Loose;
  error: string | null;
}
const demoTasks = new Map<string, Task>();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
function demoBlocked(method: string, path: string) {
  track('change_blocked', { feature: changeFeature(method, path) }); // the demo's usage counts (analytics.ts)
  window.dispatchEvent(new CustomEvent('demo-blocked'));
  return Object.assign(new Error(DEMO_NOT_SAVED), { demo: true });
}
/** A finished stand-in task for a demo AI action: the steps the real one shows, and its sample result. */
function demoTask(kind: string, steps: string[], result: object) {
  const id = `demo-${demoTasks.size + 1}`;
  const at = new Date().toISOString();
  demoTasks.set(id, { id: null, kind, status: 'done', steps: steps.map((message) => ({ at, message })), log: [], result: { ...result, sample: true }, error: null });
  return { taskId: id };
}

/** fetch, with the browser's bare "Failed to fetch" turned into a message that says what to do. */
async function send(path: string, init: RequestInit) {
  if (demoMode && init?.method && !['GET', 'HEAD'].includes(init.method) && !DEMO_ALLOWED.test(path.split('?')[0] as string)) throw demoBlocked(init.method, path);
  try {
    return await fetch(path, init);
  } catch {
    throw new Error(OFFLINE);
  }
}

const methodOf = (route: ApiRoute) => route.slice(0, route.indexOf(' '));

/** One API call: route is its api-types.ts key, path the URL with its values filled in. */
async function request<R extends ApiRoute>(route: R, path: string, body?: ApiBody<R>): Promise<ApiResponse<R>> {
  const res = await send(path, {
    method: methodOf(route),
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
async function uploadFile<R extends ApiRoute>(route: R, path: string, file: File, limit: string): Promise<ApiResponse<R>> {
  const res = await send(path, {
    method: methodOf(route),
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

type Id = number | string;

export const api = {
  me: () => request('GET /api/me', '/api/me'),
  account: () => request('GET /api/account', '/api/account'),
  saveClaudeKey: (key: string) => request('PUT /api/account/claude-key', '/api/account/claude-key', { key }),
  removeClaudeKey: () => request('DELETE /api/account/claude-key', '/api/account/claude-key'),
  accountSearch: () => request('GET /api/account/search', '/api/account/search'),
  saveAccountSearch: (body: ApiBody<'PUT /api/account/search'>) => request('PUT /api/account/search', '/api/account/search', body),
  saveAccountProfile: (text: string, source: ApiBody<'PUT /api/account/profile'>['source'] = 'typed') => request('PUT /api/account/profile', '/api/account/profile', { text, source }),
  profileVersions: () => request('GET /api/account/profile/versions', '/api/account/profile/versions'),
  profileVersion: (n: Id) => request('GET /api/account/profile/versions/:n', `/api/account/profile/versions/${n}`),
  restoreProfileVersion: (n: Id) => request('POST /api/account/profile/versions/:n/restore', `/api/account/profile/versions/${n}/restore`),
  // The knowledge doc from a document: its text, not saved.
  profileFromFile: (file: File) => uploadFile('POST /api/account/profile/from-file', '/api/account/profile/from-file', file, '5 MB'),
  // A job's cover letter versions, revising with Claude, and saving or restoring a version (server/letter-routes.ts).
  letters: (id: Id) => request('GET /api/postings/:id/letters', `/api/postings/${id}/letters`),
  letterHeader: () => request('GET /api/letter-header', '/api/letter-header'),
  saveLetterHeader: (header: ApiBody<'PUT /api/letter-header'>) => request('PUT /api/letter-header', '/api/letter-header', header),
  followUps: () => request('GET /api/follow-ups', '/api/follow-ups'),
  setStaleDays: (staleDays: number) => request('PUT /api/follow-ups/settings', '/api/follow-ups/settings', { staleDays }),
  staleApplications: () => request('GET /api/follow-ups/stale', '/api/follow-ups/stale'),
  closeStale: () => request('POST /api/follow-ups/close-stale', '/api/follow-ups/close-stale'),
  closeNoResponse: (id: Id) => request('POST /api/postings/:id/close-no-response', `/api/postings/${id}/close-no-response`),
  findContact: async (id: Id): Promise<ApiResponse<'POST /api/postings/:id/find-contact'>> => {
    if (!demoMode) return request('POST /api/postings/:id/find-contact', `/api/postings/${id}/find-contact`);
    return sampled('find_contact', async () => {
      const { markdown } = await api.findContactSample(id);
      return demoTask('find-contact', ['Searching for the hiring manager and a recruiter (about a minute)', 'Sample answer ready (demo: no AI, nothing saved)'], { markdown });
    });
  },
  findContactSample: (id: Id) => request('GET /api/postings/:id/find-contact/sample', `/api/postings/${id}/find-contact/sample`), // the demo's canned answer
  excludedSites: () => request('GET /api/excluded-sites', '/api/excluded-sites'),
  skipSite: (site: string, note = '') => request('POST /api/excluded-sites', '/api/excluded-sites', { site, note }),
  setSiteNote: (site: string, note: string) => request('PATCH /api/excluded-sites/:site', `/api/excluded-sites/${encodeURIComponent(site)}`, { note }),
  unskipSite: (site: string) => request('DELETE /api/excluded-sites/:site', `/api/excluded-sites/${encodeURIComponent(site)}`),
  removeSiteJobs: (site: string) => request('POST /api/excluded-sites/:site/remove-jobs', `/api/excluded-sites/${encodeURIComponent(site)}/remove-jobs`),
  reviseLetter: async (id: Id, body: ApiBody<'POST /api/postings/:id/letter/revise'>): Promise<ApiResponse<'POST /api/postings/:id/letter/revise'>> => {
    if (!demoMode) return request('POST /api/postings/:id/letter/revise', `/api/postings/${id}/letter/revise`, body);
    return sampled('letter_revision', async () => {
      const [{ sampleRevision }, job] = await Promise.all([demoSamples(), api.get(id), pause(1200)]);
      return sampleRevision({ ...body, company: job.company, title: job.title });
    });
  },
  saveLetter: (id: Id, content: string, source: ApiBody<'POST /api/postings/:id/letter'>['source']) => request('POST /api/postings/:id/letter', `/api/postings/${id}/letter`, { content, source }),
  restoreLetter: (id: Id, versionId: ApiBody<'POST /api/postings/:id/letter/restore'>['versionId']) => request('POST /api/postings/:id/letter/restore', `/api/postings/${id}/letter/restore`, { versionId }),
  // The fact check on a letter version; in the demo, a canned sample (nothing is saved or counted).
  checkLetter: async (id: Id, versionId: Id): Promise<ApiResponse<'POST /api/postings/:id/letters/:versionId/check'>> => {
    if (!demoMode) return request('POST /api/postings/:id/letters/:versionId/check', `/api/postings/${id}/letters/${versionId}/check`);
    const [{ sampleCheck }] = await Promise.all([demoSamples(), pause(1200)]);
    return sampleCheck();
  },
  dismissClaim: (id: Id, versionId: Id, index: number) => request('POST /api/postings/:id/letters/:versionId/claims/:index/dismiss', `/api/postings/${id}/letters/${versionId}/claims/${index}/dismiss`),
  letterFromFile: (id: Id, file: File) => uploadFile('POST /api/postings/:id/letter/from-file', `/api/postings/${id}/letter/from-file`, file, '5 MB'),
  // Settings > Resumes (server/resume-routes.ts).
  resumes: () => request('GET /api/resumes', '/api/resumes'),
  uploadResume: (file: File) => uploadFile('POST /api/resumes', '/api/resumes', file, '5 MB'),
  replaceResume: (id: Id, file: File) => uploadFile('POST /api/resumes/:id/file', `/api/resumes/${id}/file`, file, '5 MB'),
  updateResume: (id: Id, patch: ApiBody<'PATCH /api/resumes/:id'>) => request('PATCH /api/resumes/:id', `/api/resumes/${id}`, patch),
  deleteResume: (id: Id) => request('DELETE /api/resumes/:id', `/api/resumes/${id}`),
  setAccountSchedule: (on: boolean) => request('PUT /api/account/schedule', '/api/account/schedule', { on }),
  users: () => request('GET /api/admin/users', '/api/admin/users'),
  decideUser: (id: Id, decision: string) => request('POST /api/admin/users/:id/:decision', `/api/admin/users/${id}/${decision}`),
  setUserAi: (id: Id, source: ApiBody<'PUT /api/admin/users/:id/ai'>['source'], capUsd: number | null = null, confirmEmail: string | undefined = undefined) =>
    request('PUT /api/admin/users/:id/ai', `/api/admin/users/${id}/ai`, { source, capUsd, ...(confirmEmail ? { confirmEmail } : {}) }),
  sendFeedback: (body: string, page: string) => request('POST /api/feedback', '/api/feedback', { body, page }),
  pauseAccount: () => request('POST /api/account/pause', '/api/account/pause'),
  help: () => request('GET /api/help', '/api/help'),
  buildDraft: async (payload: ApiBody<'POST /api/account/draft'>): Promise<ApiResponse<'POST /api/account/draft'>> => {
    if (!demoMode) return request('POST /api/account/draft', '/api/account/draft', payload);
    return sampled('profile_draft', async () => {
      const [{ sampleDraft }] = await Promise.all([demoSamples(), pause(1500)]);
      return sampleDraft();
    });
  },
  askHelp: async (question: string): Promise<ApiResponse<'POST /api/help/ask'>> => {
    if (!demoMode) return request('POST /api/help/ask', '/api/help/ask', { question });
    return sampled('help_answer', async () => {
      const [{ sampleHelpAnswer }, guides] = await Promise.all([demoSamples(), api.help(), pause(800)]);
      return sampleHelpAnswer(question, guides);
    });
  },
  setTimeZone: (timeZone: string | null) => request('PUT /api/account/timezone', '/api/account/timezone', { timeZone }),
  resumeAccount: () => request('POST /api/account/resume', '/api/account/resume'),
  deleteAccount: (confirmEmail: string) => request('POST /api/account/delete', '/api/account/delete', { confirmEmail }),
  deleteUser: (id: Id, confirmEmail: string) => request('POST /api/admin/users/:id/delete', `/api/admin/users/${id}/delete`, { confirmEmail }),
  adminFeedback: () => request('GET /api/admin/feedback', '/api/admin/feedback'),
  adminUsage: (weeks = 12) => request('GET /api/admin/usage', `/api/admin/usage?weeks=${weeks}`),
  feedbackDone: (id: Id) => request('POST /api/admin/feedback/:id/done', `/api/admin/feedback/${id}/done`),
  /** Sends the file as the raw body with its name and type in headers (no multipart). */
  uploadAttachment: async (jobId: Id, file: File): Promise<ApiResponse<'POST /api/postings/:id/attachments'>> => {
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
  deleteAttachment: async (id: Id) => {
    const res = await send(`/api/attachments/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
  },
  signOut: () => fetch('/auth/logout', { method: 'POST' }),
  summary: () => request('GET /api/summary', '/api/summary'),
  saveLayout: (area: 'home', order: ApiBody<'PUT /api/layout/home'>['order']) => request('PUT /api/layout/home', `/api/layout/${area}`, { order }), // home is the one arranged screen
  list: (filters: Record<string, unknown>) => {
    // URLSearchParams turns each value into text, as it always has.
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '' && v != null && v !== false) as Array<[string, string]>);
    return request('GET /api/postings', `/api/postings?${q}`);
  },
  get: (id: Id) => request('GET /api/postings/:id', `/api/postings/${id}`),
  update: (id: Id, patch: ApiBody<'PATCH /api/postings/:id'>) => request('PATCH /api/postings/:id', `/api/postings/${id}`, patch),
  add: (job: ApiBody<'POST /api/postings'>) => request('POST /api/postings', '/api/postings', job),
  action: async (id: Id, action: string): Promise<ApiResponse<'POST /api/postings/:id/actions/:action'>> => {
    // In the demo the AI actions answer with samples; Refetch posting changes data, so it is stopped like any change.
    if (!demoMode || !['score', 'write-materials', 'regenerate'].includes(action)) return request('POST /api/postings/:id/actions/:action', `/api/postings/${id}/actions/${action}`);
    return sampled(action === 'score' ? 'fit_evaluation' : 'cover_letter', async () => {
      const [m, job] = await Promise.all([demoSamples(), api.get(id), pause(1200)]);
      if (action === 'score') return demoTask(action, ['Reading the posting', 'Scoring with Sonnet 5.5', 'Sample score ready (demo: no AI, nothing saved)'], { score: m.sampleScore(job) });
      return demoTask(action, ['Writing resume tweaks', 'Writing the cover letter', 'Sample ready (demo: no AI, nothing saved)'], { letter: m.sampleLetter(job, { regenerate: action === 'regenerate' }), tweaks: m.sampleTweaks(job) });
    });
  },
  addNote: (id: Id, body: string) => request('POST /api/postings/:id/notes', `/api/postings/${id}/notes`, { body }),
  updateNote: (noteId: Id, body: string) => request('PATCH /api/notes/:id', `/api/notes/${noteId}`, { body }),
  deleteNote: async (noteId: Id) => {
    const res = await send(`/api/notes/${noteId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
  },
  startPrep: async (id: Id, body: ApiBody<'POST /api/postings/:id/meeting-prep'>): Promise<ApiResponse<'POST /api/postings/:id/meeting-prep'>> => {
    if (!demoMode) return request('POST /api/postings/:id/meeting-prep', `/api/postings/${id}/meeting-prep`, body);
    return sampled('meeting_prep', async () => {
      const [{ samplePrep }, job] = await Promise.all([demoSamples(), api.get(id), pause(1500)]);
      const steps = [body.research ? 'Researching the people and the company, then writing the prep (a few minutes)' : 'Writing the prep', 'Sample prep ready (demo: no AI, nothing saved)'];
      return demoTask('meeting-prep', steps, { prep: { id: 'demo-sample', content: samplePrep(job, body), createdAt: new Date().toISOString(), model: 'a canned sample (no AI)', research: false, webSearches: 0, costUsd: null } });
    });
  },
  prep: (prepId: string) => request('GET /api/meeting-preps/:id', `/api/meeting-preps/${prepId}`),
  deletePrep: async (prepId: string) => {
    const res = await send(`/api/meeting-preps/${prepId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
  },
  task: (id: string): Promise<Task> => (demoTasks.has(id) ? Promise.resolve(demoTasks.get(id) as Task) : request('GET /api/tasks/:id', `/api/tasks/${id}`)),
  tasks: () => request('GET /api/tasks', '/api/tasks'),
  taskLog: (id: string, from = 0) => request('GET /api/tasks/:id/log', `/api/tasks/${id}/log?from=${from}`),
  pipeline: () => request('GET /api/pipeline', '/api/pipeline'),
  runPipeline: () => request('POST /api/pipeline/run', '/api/pipeline/run'),
  inbox: () => request('GET /api/inbox', '/api/inbox'),
  checkInbox: () => request('POST /api/inbox/check', '/api/inbox/check'),
  reviewEmail: (id: string, choice: ApiBody<'POST /api/inbox/emails/:id/review'>['choice'], postingId?: number | null) =>
    request('POST /api/inbox/emails/:id/review', `/api/inbox/emails/${id}/review`, { choice, ...(postingId ? { postingId } : {}) }),
  closeReminder: (id: string, status: ApiBody<'PATCH /api/inbox/reminders/:id'>['status']) => request('PATCH /api/inbox/reminders/:id', `/api/inbox/reminders/${id}`, { status }),
  funnel: (days: Id, track?: string) => request('GET /api/funnel', `/api/funnel?days=${days}${track && track !== 'all' ? `&track=${track}` : ''}`),
  lookups: () => request('GET /api/lookups', '/api/lookups'),
  budget: () => request('GET /api/spending', '/api/spending'),
  setBudget: (limitUsd: number) => request('PUT /api/admin/budget', '/api/admin/budget', { limitUsd }),
  adminLookups: () => request('GET /api/admin/lookups', '/api/admin/lookups'),
  addLookup: (list: string, value: ApiBody<'POST /api/admin/lookups/:list'>) => request('POST /api/admin/lookups/:list', `/api/admin/lookups/${list}`, value),
  updateLookup: (list: string, id: string, patch: ApiBody<'PATCH /api/admin/lookups/:list/:id'>) => request('PATCH /api/admin/lookups/:list/:id', `/api/admin/lookups/${list}/${id}`, patch),
  setLookupRole: (list: string, role: string, valueId: string) => request('PUT /api/admin/lookups/:list/roles', `/api/admin/lookups/${list}/roles`, { role, valueId }),
  prompts: () => request('GET /api/prompts', '/api/prompts'),
  prompt: (name: string) => request('GET /api/prompts/:name', `/api/prompts/${name}`),
  savePrompt: (name: string, template: string, note?: string) => request('PUT /api/prompts/:name', `/api/prompts/${name}`, { template, ...(note ? { note } : {}) }),
  restorePrompt: (name: string, versionId: ApiBody<'POST /api/prompts/:name/restore'>['versionId']) => request('POST /api/prompts/:name/restore', `/api/prompts/${name}/restore`, { versionId }),
  previewPrompt: (name: string, template: string, postingId?: Id | null) =>
    request('POST /api/prompts/:name/preview', `/api/prompts/${name}/preview`, { template, ...(postingId ? { postingId: Number(postingId) } : {}) }),
};

/** Polls a background task, reporting each update, until it finishes. Resolves with the final task. */
export async function followTask(taskId: string, onUpdate?: (task: Task) => void) {
  for (;;) {
    const task = await api.task(taskId);
    onUpdate?.(task);
    if (task.status !== 'running') return task;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
