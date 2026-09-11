# Gmail Email QA Reference

## Purpose

This runbook verifies the repo's email-channel path in the lowest-risk order:

1. Static health: build + tests.
2. Connection health: settings screen + provider auth.
3. Safe behavior: inbound mail creates a session and draft.
4. Controlled send: one reply in the same thread.

Read `/Users/meharaj/WA-copilot/docs/app-behavior.md` first when there is any question about current expected behavior.

## Safety Boundaries

### What is low-risk in the current implementation

- Email secrets are stored via Electron `safeStorage` handlers in [src/main/ipc/secure.ts](/Users/meharaj/WA-copilot/src/main/ipc/secure.ts:1), so passwords are not meant to live in plaintext repo files.
- Gmail OAuth uses only read/send scopes in [src/main/services/GmailOAuthService.ts](/Users/meharaj/WA-copilot/src/main/services/GmailOAuthService.ts:13) when that optional mode is selected.
- The email QA path should start with `Draft Mode` on and `Auto-Reply` off.
- Attachment download is disabled in runtime config.
- The current flow does not require delete/archive actions.

### What is not zero-risk

- Gmail OAuth still grants mailbox access for the requested scopes.
- Gmail IMAP/SMTP app passwords are broader mailbox credentials for email clients and should be treated as revocable secrets.
- Any bug in reply routing can send an unintended message, so first-pass testing should use a test mailbox and a second throwaway sender account.

### Recommended Test Mailbox Strategy

- Best: dedicated Gmail support test inbox.
- Acceptable: secondary Gmail account.
- Avoid: primary personal mailbox or work-critical mailbox for the first verification pass.

## Auth Choice

### Option A: Gmail App Password (recommended)

Use for the main client-side verification path.

Required Google-side prerequisites:

- 2-Step Verification enabled on the Gmail account.
- App Password generated for mail-client access.
- IMAP available for the account.

Gmail client settings:

- IMAP host: `imap.gmail.com`
- IMAP port: `993`
- SMTP host: `smtp.gmail.com`
- SMTP port: `587`

### Option B: OAuth

Use only when you intentionally want to test the optional Google sign-in path and both env vars exist:

- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`

Current repo note:

- Packaged app launches from Finder do not automatically inherit the repo root `.env`.
- If OAuth is missing at runtime, either relaunch with env in the shell or stay on app-password mode for QA.

## Manual QA Flow

### A. Preflight

Run:

```bash
./.agents/skills/qa-email-gmail-verification/scripts/preflight.sh
```

Expected:

- `typecheck`, `test:unit`, and `test:integration` pass.
- App bundle exists locally.

### B. Connection Test

1. Open the installed app.
2. Go to `Settings -> Email Channel`.
3. Select Gmail.
4. Enter Gmail address.
5. For app password:
   - Keep `App Password` selected under Gmail auth mode.
   - Enter the Gmail address and app password.
   - Expand server settings only if you want to inspect them.
   - Confirm `imap.gmail.com : 993` and `smtp.gmail.com : 587`.
6. For OAuth:
   - Click `Sign in with Google`.
   - Complete login in browser yourself.
   - Return and confirm the connected identity is shown.
7. Click `Test Connection`.

Expected:

- Success message: `Connection successful. You can now enable the email channel.`

### C. Safe Runtime Verification

1. Keep `Draft Mode` on.
2. Keep `Auto-Reply` off.
3. Turn `Enable Email Channel` on only after connection test passes.
4. Turn `Auto-Reply` on for inbound-email-to-agent testing. Current implementation ignores inbound email when auto-reply is off.
5. From a second mailbox, send a simple safe message like:

```text
Subject: QA Email Thread Check

Hello, can you confirm your support hours?
```

Expected:

- A new email-channel session appears.
- The inbound content is visible in the session.
- The agent prepares a draft or a reviewed response path first.

### D. Controlled Reply Verification

1. Approve or manually trigger one reply.
2. Verify in the sender mailbox:
   - The message arrives once.
   - It stays in the same thread.
   - `Re:` subject behavior is correct.
   - No duplicate sends occur.

### E. Shutdown / Cleanup

- If app-password fallback was used only for QA, revoke the app password after testing if you do not plan to keep the mailbox connected.
- If a dedicated test inbox was used, keep the credential only if ongoing QA is expected.

## Failure Triage

### `Google OAuth is not configured in this app`

Cause:

- Runtime env vars for Gmail OAuth are missing.

Action:

- Provide runtime env and relaunch, or use app-password fallback.

### `Connection failed`

Check:

- Wrong host/port.
- Wrong app password.
- IMAP unavailable for account type.
- GUI app missing shell PATH for `uvx` on MCP path.

### No session appears after inbound mail

Check:

- Email channel actually enabled.
- Connection state still `connected`.
- Polling interval waited long enough.
- Inbound mail is recent and not filtered as self-sent.

### Reply sends but thread breaks

Check:

- `Message-ID`, `In-Reply-To`, and `References` propagation.
- Whether the sender mailbox rewrote subject or client headers.

## Pass Criteria

- Build/test preflight clean.
- One successful connection test.
- One inbound email becomes a session.
- One reply or draft generated.
- One verified same-thread outbound response.
- No duplicate or self-looped sends.
