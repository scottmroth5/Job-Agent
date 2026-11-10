// A fake of the Gmail API surface the inbox uses, with synthetic messages only. Records every call.
/** @import { gmail_v1 } from '@googleapis/gmail' */
const b64 = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('base64url');

/**
 * A Gmail API message (format full) built from simple fields.
 * @param {{ id: string, threadId?: string, from: string, subject: string, body?: string, html?: boolean, date?: string, labelIds?: string[] }} m
 */
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

/** @typedef {ReturnType<typeof message>} FakeMessage */
/** @typedef {{ id: string, name: string }} FakeLabel */
/** What a call was given: the fields the inbox sends and tests read. */
/** @typedef {{ userId?: string, id?: string, q?: string, startHistoryId?: string, requestBody?: { name?: string, addLabelIds?: string[] } }} FakeCallArgs */

/**
 * @param {{ messages?: FakeMessage[], me?: string, historyId?: string, history?: Record<string, string[]>, expiredHistory?: boolean, labels?: FakeLabel[] }} o
 *   history: { [startHistoryId]: messageIds[] }; messages with the SENT label are what in:sent lists
 */
export function fakeGmailApi(o = {}) {
  /** @type {Array<{ name: string, args: FakeCallArgs }>} */
  const calls = [];
  const messages = new Map((o.messages ?? []).map((m) => [m.id, m]));
  const labels = [...(o.labels ?? [])];
  const err404 = () => Object.assign(new Error('Requested entity was not found.'), { code: 404 });
  const rec = (/** @type {string} */ name, /** @type {FakeCallArgs} */ args) => calls.push({ name, args });
  const api = {
    users: {
      getProfile: async (/** @type {FakeCallArgs} */ a) => (rec('getProfile', a), { data: { emailAddress: o.me ?? 'me@example.net', historyId: o.historyId ?? '9000' } }),
      history: {
        list: async (/** @type {{ startHistoryId: string }} */ a) => {
          rec('history.list', a);
          if (o.expiredHistory) throw err404();
          const ids = o.history?.[a.startHistoryId] ?? [];
          return { data: { historyId: o.historyId ?? '9000', history: ids.map((id) => ({ messagesAdded: [{ message: { id } }] })) } };
        },
      },
      messages: {
        list: async (/** @type {{ q?: string }} */ a) => {
          rec('messages.list', a);
          const sent = /in:sent/.test(a.q ?? '');
          const hits = [...messages.values()].filter((m) => !sent || m.labelIds.includes('SENT'));
          return { data: { messages: hits.map((m) => ({ id: m.id, threadId: m.threadId })) } };
        },
        get: async (/** @type {{ id: string }} */ a) => (rec('messages.get', a), { data: messages.get(a.id) }),
      },
      threads: {
        modify: async (/** @type {FakeCallArgs} */ a) => (rec('threads.modify', a), { data: {} }),
      },
      labels: {
        list: async (/** @type {FakeCallArgs} */ a) => (rec('labels.list', a), { data: { labels } }),
        create: async (/** @type {{ requestBody: { name: string } }} */ a) => {
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

/**
 * The fake typed as the Gmail client createGmail takes: it has only the calls the inbox makes.
 * @param {ReturnType<typeof fakeGmailApi>['api']} api
 */
export const asGmailApi = (api) => /** @type {Pick<gmail_v1.Gmail, 'users'>} */ (/** @type {unknown} */ (api));
