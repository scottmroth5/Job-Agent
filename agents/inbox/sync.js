// Which messages to look at: new ones since the stored Gmail historyId, or a window of days.
import { getSetting, setSetting } from '../../db/settings.js';
import { HistoryExpiredError } from './gmail.js';

export const CURSOR_KEY = 'inbox.historyId';

const windowQuery = (days) => `newer_than:${days}d -in:chats`;

/**
 * New message IDs since the last run. mode: 'history' (normal), 'fallback' (the stored historyId was
 * rejected as too old; the last fallbackDays are read instead), or 'initial' (first run, same window).
 * The cursor is not saved here: call saveCursor(db, nextHistoryId) once the messages are processed.
 */
export async function newMessageIds({ gmail, db, fallbackDays = 7 }) {
  const stored = getSetting(db, CURSOR_KEY);
  if (stored) {
    try {
      const { messageIds, historyId } = await gmail.historySince(stored);
      return { messageIds, nextHistoryId: historyId, mode: 'history' };
    } catch (err) {
      if (!(err instanceof HistoryExpiredError)) throw err;
    }
  }
  const { historyId } = await gmail.profile();
  const messageIds = await gmail.listMessages(windowQuery(fallbackDays));
  return { messageIds, nextHistoryId: historyId, mode: stored ? 'fallback' : 'initial' };
}

/** Message IDs in the last `days` days (inbox:backfill), with the historyId to continue from afterwards. */
export async function backfillMessageIds({ gmail, days = 180 }) {
  const { historyId } = await gmail.profile();
  return { messageIds: await gmail.listMessages(windowQuery(days)), nextHistoryId: historyId, mode: 'backfill' };
}

export const saveCursor = (db, historyId) => historyId && setSetting(db, CURSOR_KEY, String(historyId));
