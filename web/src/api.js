// Thin client for the Job Agent API (see /api/openapi.json).

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const api = {
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
  pipeline: () => request('GET', '/api/pipeline'),
  runPipeline: () => request('POST', '/api/pipeline/run'),
  inbox: () => request('GET', '/api/inbox'),
  checkInbox: () => request('POST', '/api/inbox/check'),
  reviewEmail: (id, choice, postingId) => request('POST', `/api/inbox/emails/${id}/review`, { choice, ...(postingId ? { postingId } : {}) }),
  closeReminder: (id, status) => request('PATCH', `/api/inbox/reminders/${id}`, { status }),
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
