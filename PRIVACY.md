# Privacy Policy

Job Agent is a personal tool. It is run by the owner of this repository for their own job search and is not offered as a service to anyone else.

## What it accesses

When the operator signs in with their Google account, Job Agent requests only these permissions:

- **Google Docs, read only** (`documents.readonly`): reads the reference document the operator configures.
- **Google Drive, app-created files only** (`drive.file`): creates and updates the draft documents and folder that Job Agent itself makes. It cannot see other files in Drive.
- **Gmail, send only** (`gmail.send`): sends summary emails to the operator. It cannot read the inbox.

## How data is used

- Data is used only to find and evaluate job postings and to draft application materials for the operator.
- Text from job postings and from the operator's reference document is sent to the Anthropic Claude API for analysis.
- Everything else stays in the operator's own environment (a local database and configuration files) and in the operator's own Google account.
- Data is not sold, shared with third parties, or used for advertising.
- Use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including its Limited Use requirements.

## Revoking access

The operator can revoke Job Agent's access at any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Contact

Questions about this policy can be raised as an issue on this repository.
