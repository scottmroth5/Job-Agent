// Thin client for the Job Agent API (see /api/openapi.json).

async function request(method, path, body) {
  const res = await fetch(path, {
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
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const api = {
  me: () => request('GET', '/api/me'),
  signOut: () => fetch('/auth/logout', { method: 'POST' }),
  summary: () => request('GET', '/api/summary'),
  list: (filters) => {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '' && v != null && v !== false));
    return request('GET', `/api/postings?${q}`);
  },
  get: (id) => request('GET', `/api/postings/${id}`),
  update: (id, patch) => request('PATCH', `/api/postings/${id}`, patch),
  add: (job) => request('POST', '/api/postings', job),
  action: (id, action) => request('POST', `/api/postings/${id}/actions/${action}`),
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
