# Privacy Policy

Job Hunt (Job Agent) is a private job search tool. Its owner runs it for their own search and for the people they invite.

## Signing in

You sign in with Google. The app asks Google only for your email address and that it is verified (the `openid` and `email` scopes). It uses them to recognize your account and to email you about it.

## What the app keeps about you

- **Your account:** your email address, the name and note you gave when you asked for access, when you accepted these terms, and whether your account is pending, active, or paused.
- **Your job search:** the jobs, notes, files, scores, and documents you add or the app makes for you. Each account sees only its own.
- **Your Claude API key,** if you add one: stored encrypted, used only for your own AI requests, and never shown again, to you, the owner, or anyone else.
- **Usage records:** when the app ran AI requests for you and what they cost, so spending can be shown and capped.

## How it is used

- Only to run the app for you. Data is not sold, shared with third parties, or used for advertising.
- Job postings and the material you give the app are sent to Anthropic's Claude API when you use an AI feature.
- The app emails you only about your own account (for example, that it was approved). The owner is emailed when someone asks for access.
- The owner can see each account's email address, status, and AI spending, but not your jobs, notes, or key.

## The owner's Google access

The owner's own Google sign-in lets the app read the owner's reference document (`documents.readonly`), create its own documents in the owner's Drive (`drive.file`), send the owner's report and account emails (`gmail.send`), and, for the owner's inbox feature, read and label job-related mail in the owner's own Gmail (`gmail.readonly`, `gmail.modify`). Nothing from the owner's mailbox is shown to other accounts. Use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including its Limited Use requirements.

## Where data lives

On the server that runs the app, and in an encrypted backup in the owner's Google Drive.

## Your choices

Under Settings you can, at any time:

- **Download your data:** everything that is yours, as one file.
- **Remove your Claude key.**
- **Pause your account,** and resume it later.
- **Delete your account:** it and everything in it are deleted at once. Copies inside the encrypted backups are replaced as the backups rotate, within about a month.

You can also revoke the app's Google access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Contact

Questions about this policy can be raised as an issue on this repository.
