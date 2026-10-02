// A fake of the Gmail API surface the inbox uses, with synthetic messages only. Records every call.
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

/** A Gmail API message (format full) built from simple fields. */
export function message({ id, threadId = `t-${id}`, from, subject, body = '', html = false, date = '2026-10-01T15:00:00Z', labelIds = ['INBOX'] }) {
  return {
    id,
    threadId,
    labelIds,
    internalDate: String(Date.parse(date)),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
        { name: 'Date', value: new Date(date).toUTCString() },
      ],
      parts: [{ mimeType: html ? 'text/html' : 'text/plain', body: { data: b64(body) } }],
    },
  };
}

/**
 * @param {{ messages?: object[], me?: string, historyId?: string, history?: object, expiredHistory?: boolean, threadStarters?: Record<string, boolean> }} o
 *   history: { [startHistoryId]: messageIds[] }; threadStarters: threadId -> first message sent by me
 */
export function fakeGmailApi(o = {}) {
  const calls = [];
  const messages = new Map((o.messages ?? []).map((m) => [m.id, m]));
  const labels = [...(o.labels ?? [])];
  const err404 = () => Object.assign(new Error('Requested entity was not found.'), { code: 404 });
  const rec = (name, args) => calls.push({ name, args });
  const api = {
    users: {
      getProfile: async (a) => (rec('getProfile', a), { data: { emailAddress: o.me ?? 'me@example.net', historyId: o.historyId ?? '9000' } }),
      history: {
        list: async (a) => {
          rec('history.list', a);
          if (o.expiredHistory) throw err404();
          const ids = o.history?.[a.startHistoryId] ?? [];
          return { data: { historyId: o.historyId ?? '9000', history: ids.map((id) => ({ messagesAdded: [{ message: { id } }] })) } };
        },
      },
      messages: {
        list: async (a) => (rec('messages.list', a), { data: { messages: [...messages.keys()].map((id) => ({ id })) } }),
        get: async (a) => (rec('messages.get', a), { data: messages.get(a.id) }),
      },
      threads: {
        get: async (a) => (rec('threads.get', a), { data: { messages: [{ labelIds: o.threadStarters?.[a.id] ? ['SENT'] : ['INBOX'] }] } }),
        modify: async (a) => (rec('threads.modify', a), { data: {} }),
      },
      labels: {
        list: async (a) => (rec('labels.list', a), { data: { labels } }),
        create: async (a) => {
          rec('labels.create', a);
          const l = { id: `L${labels.length + 1}`, name: a.requestBody.name };
          labels.push(l);
          return { data: l };
        },
      },
    },
  };
  return { api, calls };
}
