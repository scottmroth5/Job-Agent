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
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '' && v != null));
    return request('GET', `/api/postings?${q}`);
  },
  get: (id) => request('GET', `/api/postings/${id}`),
  update: (id, patch) => request('PATCH', `/api/postings/${id}`, patch),
  add: (job) => request('POST', '/api/postings', job),
  action: (id, action) => request('POST', `/api/postings/${id}/actions/${action}`),
  task: (id) => request('GET', `/api/tasks/${id}`),
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
