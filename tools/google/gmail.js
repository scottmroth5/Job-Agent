import { gmail } from '@googleapis/gmail';

// RFC 2047 encoding keeps non-ASCII subjects intact.
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

/** Builds the base64url RFC 822 message the Gmail API expects. Exactly one of text or html. */
export function buildRawEmail({ to, subject, text, html }) {
  if (!to || !subject) throw new TypeError('buildRawEmail: to and subject are required');
  if (!text === !html) throw new TypeError('buildRawEmail: pass exactly one of text or html');
  const message = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html ?? text, 'utf8').toString('base64'),
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

/** Sends an email as the signed-in user. Returns the Gmail message id. */
export async function sendEmail(auth, email) {
  const { data } = await gmail({ version: 'v1', auth }).users.messages.send({
    userId: 'me',
    requestBody: { raw: buildRawEmail(email) },
  });
  return data.id;
}
