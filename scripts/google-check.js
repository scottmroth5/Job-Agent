// Confirms the Google sign-in works (letter and prep Docs, Drive backups, and Gmail use it): it refreshes the access
// token and prints only whether that worked. The knowledge doc lives in the app now, not in Google.
//   npm run google:check                       check the sign-in
//   npm run google:check -- --send-test-email  also send a test email to EMAIL_ADDRESS
import { getGoogleAuth } from '../tools/google/auth.js';
import { sendEmail } from '../tools/google/gmail.js';

async function main() {
  const auth = getGoogleAuth();
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error('No access token came back.');
  console.log('Google sign-in works.');

  if (process.argv.includes('--send-test-email')) {
    const to = process.env.EMAIL_ADDRESS;
    if (!to) throw new Error('EMAIL_ADDRESS is not set in .env.');
    const id = await sendEmail(auth, {
      to,
      subject: 'Job Agent: Gmail test',
      text: 'This is a test message from Job Agent. Gmail sending works.',
    });
    console.log(`Test email sent (message id ${id}).`);
  }
}

main().catch((err) => {
  const status = err.response?.status ?? err.code;
  console.error(`Google check failed${status ? ` (${status})` : ''}: ${err.message}`);
  if (/invalid_grant/.test(err.message)) console.error('The saved sign-in is no longer valid. Run "npm run google:login".');
  process.exitCode = 1;
});
