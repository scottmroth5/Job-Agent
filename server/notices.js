// Account emails (multi-user, phase 2). The only emails the app sends besides the owner's report and alerts:
//   to the owner (EMAIL_ADDRESS): someone asked for access, a user reached their monthly AI allowance;
//   to a person, about their own account only: approved, not approved, paused, allowance reached.
// Each notice picks its own recipient here, so no caller can address anyone else. They hold names, addresses, and links
// only, never job data, and a failure to send never fails the action that caused it (the reason is logged, not the email).

/**
 * @param {object} o
 * @param {(email: { to: string, subject: string, text: string }) => Promise<unknown>} [o.send]  tools/google/gmail.js sendEmail with the owner's sign-in
 * @param {() => string|null} o.owner   the owner's address (EMAIL_ADDRESS)
 * @param {() => string} o.appUrl       PUBLIC_URL
 * @param {{ warn?: Function }} [o.log]
 */
export function createNotices({ send, owner, appUrl, log = console }) {
  const deliver = async (to, subject, text) => {
    if (!send || !to) return false;
    try {
      await send({ to, subject: `Job Hunt: ${subject}`, text });
      return true;
    } catch (err) {
      log.warn?.(`[notice] could not send "${subject}": ${err.message}`);
      return false;
    }
  };
  const link = (hash = '') => `${appUrl() || ''}/${hash}`;
  const who = (u) => (u.name ? `${u.name} (${u.email})` : u.email);

  return {
    /** To the owner: a new access request, with a link to the Users screen. */
    accessRequested: (user) =>
      deliver(owner(), 'access request', `${who(user)} asked for access to Job Hunt.\n\nApprove or reject it on Admin > Users: ${link('#/admin/users')}\n`),
    /** To the user: their request was approved. */
    approved: (user) =>
      deliver(user.email, 'your access is approved', `Hi${user.name ? ` ${user.name}` : ''},\n\nYour Job Hunt account is ready. Sign in at ${link()}\n\nTo use the AI features, add your Claude API key under Settings.\n`),
    /** To the user: their request was not approved. */
    rejected: (user) => deliver(user.email, 'your access request', 'Thanks for your interest in Job Hunt. Your request for access was not approved.\n'),
    /** To the user: their account was paused (they can still sign in and look, but not change anything or use AI). */
    paused: (user) => deliver(user.email, 'your account is paused', `Your Job Hunt account is paused: you can still sign in and look, but changes and AI are off until it is resumed. ${link()}\n`),
    /** To the user and the owner, once a month: a user on the owner's key reached their allowance. */
    allowanceReached: async (user, status) => {
      const amount = `$${status.limitUsd.toFixed(2)}`;
      await deliver(user.email, 'monthly AI allowance reached', `You have used this month's AI allowance (${amount}). AI features are off until next month or until the owner raises it.\n`);
      await deliver(owner(), 'a user reached their AI allowance', `${who(user)} used their ${amount} AI allowance for ${status.monthLabel}. Change it on Admin > Users: ${link('#/admin/users')}\n`);
    },
  };
}
