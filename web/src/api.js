// Thin client for the Job Agent API (see /api/openapi.json).

const OFFLINE = 'Cannot reach the Job Agent server. Start it with npm run ui, then try again.';

/** fetch, with the browser's bare "Failed to fetch" turned into a message that says what to do. */
async function send(path, init) {
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

export const api = {
  me: () => request('GET', '/api/me'),
  account: () => request('GET', '/api/account'),
  saveClaudeKey: (key) => request('PUT', '/api/account/claude-key', { key }),
  removeClaudeKey: () => request('DELETE', '/api/account/claude-key'),
  accountSearch: () => request('GET', '/api/account/search'),
  saveAccountSearch: (body) => request('PUT', '/api/account/search', body),
  saveAccountProfile: (text) => request('PUT', '/api/account/profile', { text }),
  setAccountSchedule: (on) => request('PUT', '/api/account/schedule', { on }),
  users: () => request('GET', '/api/admin/users'),
  decideUser: (id, decision) => request('POST', `/api/admin/users/${id}/${decision}`),
  setUserAi: (id, source, capUsd = null) => request('PUT', `/api/admin/users/${id}/ai`, { source, capUsd }),
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
  action: (id, action) => request('POST', `/api/postings/${id}/actions/${action}`),
  addNote: (id, body) => request('POST', `/api/postings/${id}/notes`, { body }),
  updateNote: (noteId, body) => request('PATCH', `/api/notes/${noteId}`, { body }),
  deleteNote: async (noteId) => {
    const res = await send(`/api/notes/${noteId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
  },
  startPrep: (id, body) => request('POST', `/api/postings/${id}/meeting-prep`, body),
  prep: (prepId) => request('GET', `/api/meeting-preps/${prepId}`),
  deletePrep: async (prepId) => {
    const res = await send(`/api/meeting-preps/${prepId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
  },
  task: (id) => request('GET', `/api/tasks/${id}`),
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
  budget: () => request('GET', '/api/admin/budget'),
  setBudget: (limitUsd) => request('PUT', '/api/admin/budget', { limitUsd }),
  adminLookups: () => request('GET', '/api/admin/lookups'),
  addLookup: (list, value) => request('POST', `/api/admin/lookups/${list}`, value),
  updateLookup: (list, id, patch) => request('PATCH', `/api/admin/lookups/${list}/${id}`, patch),
  setLookupRole: (list, role, valueId) => request('PUT', `/api/admin/lookups/${list}/roles`, { role, valueId }),
  prompts: () => request('GET', '/api/admin/prompts'),
  prompt: (name) => request('GET', `/api/admin/prompts/${name}`),
  savePrompt: (name, template, note) => request('PUT', `/api/admin/prompts/${name}`, { template, ...(note ? { note } : {}) }),
  restorePrompt: (name, versionId) => request('POST', `/api/admin/prompts/${name}/restore`, { versionId }),
  previewPrompt: (name, template, postingId) =>
    request('POST', `/api/admin/prompts/${name}/preview`, { template, ...(postingId ? { postingId: Number(postingId) } : {}) }),
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
