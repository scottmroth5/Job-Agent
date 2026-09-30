// Confirms the Google sign-in works. Reads the knowledge doc and prints only its title,
// length and an approximate token count (never the content).
//   npm run google:check                       read the knowledge doc
//   npm run google:check -- --send-test-email  also send a test email to EMAIL_ADDRESS
import { getGoogleAuth } from '../tools/google/auth.js';
import { readDoc } from '../tools/google/docs.js';
import { sendEmail } from '../tools/google/gmail.js';

const HAIKU_CACHE_MIN_TOKENS = 4096;

async function main() {
  const docId = process.env.YOUR_KNOWLEDGE_DOC_ID;
  if (!docId) throw new Error('YOUR_KNOWLEDGE_DOC_ID is not set in .env.');
  const auth = getGoogleAuth();

  const { title, text } = await readDoc(auth, docId);
  const approxTokens = Math.round(text.length / 4);
  console.log(`Knowledge doc: "${title}"`);
  console.log(`  ${text.length.toLocaleString()} characters, about ${approxTokens.toLocaleString()} tokens`);
  if (text.length < 500) console.log('  Warning: under 500 characters; v1 treated this as too short to score with.');
  console.log(
    approxTokens >= HAIKU_CACHE_MIN_TOKENS
      ? `  Above Haiku 4.5's ${HAIKU_CACHE_MIN_TOKENS}-token caching minimum (estimate), so caching should apply.`
      : `  Below Haiku 4.5's ${HAIKU_CACHE_MIN_TOKENS}-token caching minimum (estimate): caching will not apply on Haiku. ` +
          'Sonnet 5.5 and Opus 5.5 cache from 512 tokens.',
  );

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
  if (status === 403 || status === 404) {
    console.error('Check that YOUR_KNOWLEDGE_DOC_ID is right and that you signed in with the account that owns the doc.');
  }
  if (/invalid_grant/.test(err.message)) console.error('The saved sign-in is no longer valid. Run "npm run google:login".');
  process.exitCode = 1;
});
