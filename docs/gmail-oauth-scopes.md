# Gmail OAuth scope review

Date: September 9, 2026

The desktop Gmail API adapter requests exactly these scopes in
`src/main/services/GmailOAuthService.ts`:

| Scope | Use in this app | Classification / release implication |
| --- | --- | --- |
| `openid` | Identify the signed-in owner | Identity scope |
| `email` | Display and bind the owner mailbox | Identity scope |
| `https://www.googleapis.com/auth/gmail.readonly` | List and read inbound message content and headers; retrieve attachment metadata | Google lists this as restricted; it requires verification for a public app and may require the restricted-scope security assessment |
| `https://www.googleapis.com/auth/gmail.send` | Send the approved outbound email through Gmail API | Send-only scope; it does not grant read, modify, settings, or delete access |

The implementation does not request `mail.google.com`, `gmail.modify`,
`gmail.metadata`, `gmail.compose`, or Gmail settings/sharing scopes. Tokens are
stored through Electron safe storage when available, refresh failures surface a
reauthorization state, and the app never persists the OAuth client secret.

Google’s current guidance says public apps requesting sensitive or restricted
scopes must complete OAuth verification; restricted-scope apps may also need an
annual security assessment. The owner must therefore record the Cloud project,
OAuth consent-screen status, privacy-policy URL, support/contact details, data
use justification, and any verification/security-assessment outcome before
public distribution. Internal or development-only deployments may follow a
different verification path, but still remain subject to Google API policies.

Sources: [Google OAuth app verification](https://support.google.com/cloud/answer/13463073),
[verification requirements](https://support.google.com/cloud/answer/13464321),
[restricted scopes](https://support.google.com/cloud/answer/13464325), and
[OAuth scopes reference](https://developers.google.com/identity/protocols/oauth2/scopes).

This document verifies the code-level scope set and its rationale; it does not
claim that the Cloud project has completed Google verification.
