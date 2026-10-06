// The only Gmail calls the inbox makes: read the profile, history, messages, and threads, and add labels.
// There is deliberately no send, delete, trash, archive, or remove-label method here.
import { gmail as gmailApi } from '@googleapis/gmail';
import { domainOf } from './prefilter.js';

/** Gmail's per-user rate limit (15,000 units a minute): 429, or 403 with a rate-limit or quota reason. */
export function isQuotaError(err) {
  const status = err?.code ?? err?.status ?? err?.response?.status;
  const reason = err?.errors?.[0]?.reason ?? err?.response?.data?.error?.errors?.[0]?.reason ?? '';
  return status === 429 || (status === 403 && /rateLimit|quota/i.test(`${reason} ${err?.message ?? ''}`)) || /quota exceeded/i.test(err?.message ?? '');
}

// Waits before each retry after a quota error; the per-minute window clears within a minute.
export const QUOTA_WAITS_MS = [15000, 30000, 60000, 60000, 60000];

export class HistoryExpiredError extends Error {
  constructor() {
    super('The stored Gmail historyId is too old.');
    this.name = 'HistoryExpiredError';
  }
}

const header = (headers, name) => headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
const decode = (data) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

/** "Pat Example <pat@example.com>" -> { name, email } */
export function parseFrom(value) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(String(value ?? ''));
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: String(value ?? '').trim().toLowerCase() };
}

function findPart(payload, mime) {
  if (!payload) return null;
  if (payload.mimeType === mime && payload.body?.data) return payload.body.data;
  for (const p of payload.parts ?? []) {
    const hit = findPart(p, mime);
    if (hit) return hit;
  }
  return null;
}

/** Gmail API message (format full) -> the inbox's email shape. */
export function normalizeMessage(m) {
  const headers = m.payload?.headers ?? [];
  const from = parseFrom(header(headers, 'From'));
  const plain = findPart(m.payload, 'text/plain');
  const html = plain ? null : findPart(m.payload, 'text/html');
  return {
    gmailMessageId: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds ?? [],
    senderName: from.name,
    senderEmail: from.email,
    senderDomain: domainOf(from.email),
    subject: header(headers, 'Subject'),
    sentAt: new Date(Number(m.internalDate) || Date.parse(header(headers, 'Date')) || 0).toISOString(),
    rawBody: decode(plain ?? html),
    bodyIsHtml: !plain && Boolean(html),
  };
}

/** Label names Gmail accepts: "Job/<Company>" with slashes removed from the company and a sensible length. */
export function labelName(company) {
  const c = String(company ?? '').replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Unknown';
  return `Job/${c}`;
}

/**
 * @param {{ auth?: object, api?: object, waits?: number[], sleep?: (ms) => Promise, onWait?: (ms) => void }} opts
 *   api: an object shaped like gmail({ version: 'v1' }) (tests pass a fake); waits/sleep: quota retry timing
 */
export function createGmail({ auth, api = gmailApi({ version: 'v1', auth }), waits = QUOTA_WAITS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onWait = () => {} } = {}) {
  const users = api.users;
  const labelCache = new Map();

  /** Runs one API call, waiting and retrying when Gmail reports its rate limit. */
  async function call(fn) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!isQuotaError(err) || attempt >= waits.length) throw err;
        onWait(waits[attempt]);
        await sleep(waits[attempt]);
      }
    }
  }

  async function pages(fn, pick) {
    const out = [];
    let pageToken;
    do {
      const { data } = await call(() => fn(pageToken));
      out.push(...(pick(data) ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  return {
    async profile() {
      const { data } = await call(() => users.getProfile({ userId: 'me' }));
      return { emailAddress: data.emailAddress.toLowerCase(), historyId: String(data.historyId) };
    },

    /** Message IDs added since startHistoryId, and the newest historyId. Throws HistoryExpiredError on 404. */
    async historySince(startHistoryId) {
      let latest = String(startHistoryId);
      try {
        const ids = await pages(
          (pageToken) => users.history.list({ userId: 'me', startHistoryId, historyTypes: ['messageAdded'], pageToken }),
          (data) => {
            if (data.historyId) latest = String(data.historyId);
            return (data.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((x) => x.message.id));
          },
        );
        return { messageIds: [...new Set(ids)], historyId: latest };
      } catch (err) {
        if (err?.code === 404 || err?.status === 404 || err?.response?.status === 404) throw new HistoryExpiredError();
        throw err;
      }
    },

    async listMessages(q) {
      return pages((pageToken) => users.messages.list({ userId: 'me', q, maxResults: 500, pageToken }), (data) => (data.messages ?? []).map((x) => x.id));
    },

    /**
     * Threads I sent a message in during the last `days` days: one list call per 500 sent messages, instead of
     * one thread lookup (10 quota units) per incoming message.
     */
    async sentThreadIds(days) {
      const threads = await pages((pageToken) => users.messages.list({ userId: 'me', q: `in:sent newer_than:${days}d`, maxResults: 500, pageToken }), (data) => (data.messages ?? []).map((x) => x.threadId));
      return new Set(threads);
    },

    /** The message, or null when it no longer exists (deleted, or a draft that was discarded, since it was listed). */
    async getMessage(id) {
      try {
        const { data } = await call(() => users.messages.get({ userId: 'me', id, format: 'full' }));
        return normalizeMessage(data);
      } catch (err) {
        if (err?.code === 404 || err?.status === 404 || err?.response?.status === 404) return null;
        throw err;
      }
    },

    /** The label's ID, creating it when missing. */
    async ensureLabel(name) {
      if (!labelCache.size) {
        const { data } = await call(() => users.labels.list({ userId: 'me' }));
        for (const l of data.labels ?? []) labelCache.set(l.name, l.id);
      }
      if (!labelCache.has(name)) {
        const { data } = await call(() => users.labels.create({ userId: 'me', requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } }));
        labelCache.set(name, data.id);
      }
      return labelCache.get(name);
    },

    /** Adds a label to a whole thread. Never removes labels (so it never archives or marks anything read). */
    async addThreadLabel(threadId, labelId) {
      await call(() => users.threads.modify({ userId: 'me', id: threadId, requestBody: { addLabelIds: [labelId] } }));
    },
  };
}
