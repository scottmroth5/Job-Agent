// Account emails (multi-user, phase 2). The only emails the app sends besides the owner's report and alerts:
//   to the owner (EMAIL_ADDRESS): someone asked for access, a user reached their monthly AI allowance, a user sent feedback
//     (with the user as reply-to, so answering it is the owner's choice);
//   to a person, about their own account only: approved, not approved, paused, the owner now covers (or no longer
//     covers) their AI, allowance reached.
// Each notice picks its own recipient here, so no caller can address anyone else. They hold names, addresses, and links
// only, never job data, and a failure to send never fails the action that caused it (the reason is logged, not the email).

import type { BudgetStatus } from '../agents/budget.ts';

/** The account a notice is about: its name and address. */
type Person = { name?: string | null; email: string | null };

type NoticeOptions = {
  /** tools/google/gmail.ts sendEmail with the owner's sign-in. */
  send?: ((email: { to: string; subject: string; text: string; replyTo?: string }) => Promise<unknown>) | null;
  /** The owner's address (EMAIL_ADDRESS). */
  owner: () => string | null;
  /** PUBLIC_URL. */
  appUrl: () => string;
  log?: { warn?: (text: string) => void };
};

export function createNotices({ send, owner, appUrl, log = console }: NoticeOptions) {
  const deliver = async (to: string | null, subject: string, text: string, replyTo: string | null = null) => {
    if (!send || !to) return false;
    try {
      await send({ to, subject: `Job Hunt: ${subject}`, text, ...(replyTo ? { replyTo } : {}) });
      return true;
    } catch (err) {
      log.warn?.(`[notice] could not send "${subject}": ${(err as Error).message}`);
      return false;
    }
  };
  const link = (hash = '') => `${appUrl() || ''}/${hash}`;
  const who = (u: Person) => (u.name ? `${u.name} (${u.email})` : u.email);

  return {
    /** To the owner: a new access request, with a link to the Users screen. */
    accessRequested: (user: Person) =>
      deliver(owner(), 'access request', `${who(user)} asked for access to Job Hunt.\n\nApprove or reject it on Admin > Users: ${link('#/admin/users')}\n`),
    /** To the user: their request was approved. */
    approved: (user: Person) =>
      deliver(user.email, 'your access is approved', `Hi${user.name ? ` ${user.name}` : ''},\n\nYour Job Hunt account is ready. Sign in at ${link()}\n\nTo use the AI features, add your Claude API key under Settings.\n`),
    /** To the user: their request was not approved. */
    rejected: (user: Person) => deliver(user.email, 'your access request', 'Thanks for your interest in Job Hunt. Your request for access was not approved.\n'),
    /** To the user: their account was paused (they can still sign in and look, but not change anything or use AI). */
    paused: (user: Person) => deliver(user.email, 'your account is paused', `Your Job Hunt account is paused: you can still sign in and look, but changes and AI are off until it is resumed. ${link()}\n`),
    /** To the user: the owner now pays for their AI, up to a monthly cap. */
    aiCovered: (user: Person, capUsd: number | string | null) =>
      deliver(user.email, 'your AI is covered', `The owner of Job Hunt now covers your AI features, up to $${Number(capUsd).toFixed(2)} a month. You don't need your own Claude key for them. ${link('#/settings')}\n`),
    /** To the user: back on their own key. */
    aiOwnKey: (user: Person) =>
      deliver(user.email, 'your AI uses your own key again', `Your AI features now use your own Claude API key again. Add or check it under Settings: ${link('#/settings')}\n`),
    /** To the owner, with the sender as reply-to: feedback from a user (their words, as they wrote them). */
    feedback: (user: Person, body: string, page?: string | null) =>
      deliver(
        owner(),
        `feedback from ${user.name || user.email}`,
        `${who(user)} wrote${page ? ` (on ${page})` : ''}:\n\n${body}\n\nReply to this email to answer them. See all feedback on Admin > Users: ${link('#/admin/users')}\n`,
        user.email,
      ),
    /** To the user, and to the owner when the user did it: an account and everything in it was deleted. */
    accountDeleted: async (user: Person, { byOwner = false } = {}) => {
      await deliver(
        user.email,
        'your account was deleted',
        'Your Job Hunt account and everything in it (jobs, notes, letters, settings, and your saved key) have been deleted. Encrypted backups that still hold them are replaced within about a month.\n',
      );
      if (!byOwner) await deliver(owner(), 'a user deleted their account', `${who(user)} deleted their Job Hunt account.\n`);
    },
    /** To the user and the owner, once a month: a user on the owner's key reached their allowance. */
    allowanceReached: async (user: Person, status: BudgetStatus) => {
      // Reaching an allowance means there is one (limitUsd is set).
      const amount = `$${(status.limitUsd as number).toFixed(2)}`;
      await deliver(user.email, 'monthly AI allowance reached', `You have used this month's AI allowance (${amount}). AI features are off until next month or until the owner raises it.\n`);
      await deliver(owner(), 'a user reached their AI allowance', `${who(user)} used their ${amount} AI allowance for ${status.monthLabel}. Change it on Admin > Users: ${link('#/admin/users')}\n`);
    },
  };
}
