---
name: qa-email-gmail-verification
description: Verifies the app's Gmail email-channel flow end to end with explicit safety guardrails, preflight checks, and evidence capture. Use when testing email integration, Gmail setup, email QA, IMAP/SMTP fallback, or draft/send verification in this repo.
---

# QA Email Gmail Verification

## Quick Start

1. Run `./.agents/skills/qa-email-gmail-verification/scripts/preflight.sh`.
2. Read `/Users/meharaj/WA-copilot/docs/app-behavior.md` and confirm the current Email Channel contract.
3. Read [REFERENCE.md](REFERENCE.md) and choose `App Password` first, or `OAuth` only if runtime config is known-good.
4. Keep `Draft Mode` on until inbound, draft, and send checks pass.
5. Use a test mailbox or low-risk support mailbox, not a primary personal inbox.

## Workflow

### 1. Preflight

- Confirm `npm run typecheck`, `npm run test:unit`, and `npm run test:integration` pass.
- Confirm the built app exists in `dist/mac-arm64/AIConsumerAgent.app` or `/Applications/AIConsumerAgent.app`.
- Confirm whether Gmail OAuth env vars are configured, but plan to use app-password mode unless there is a reason to exercise OAuth.

### 2. Safe Test Setup

- Prefer Gmail IMAP/SMTP with an app password for the main client-side path.
- Use Gmail OAuth only when explicitly testing the optional Google sign-in mode.
- Keep attachment download disabled.
- Keep `Draft Mode` on.
- Keep `Enable Email Channel` off until `Test Connection` succeeds.
- Note that current implementation only submits inbound email into the agent when `Auto-Reply` is on.

### 3. Manual Verification

- Open `Settings -> Email Channel`.
- For app password: select `Gmail`, keep `App Password` mode active, enter the Gmail address and app password, confirm the preset hosts/ports, then run `Test Connection`.
- For OAuth: select `Gmail`, switch to `Google Sign-In`, sign in, verify connected identity, then run `Test Connection`.
- Turn on `Enable Email Channel` only after test connection passes.
- Turn on `Auto-Reply` when you want inbound email to create agent sessions in the current implementation.
- Send one inbound email from a second mailbox.
- Verify a session is created under the email channel.
- Verify the assistant creates a draft first.
- Approve or manually send one safe reply.
- Verify the reply lands in the correct thread with `Re:` / reply headers.

### 4. Evidence To Capture

- Build/test command results.
- Which auth path was used: `App Password` or `OAuth`.
- Whether connection test passed.
- Whether inbound mail created a session.
- Whether a draft was created before send.
- Whether the reply stayed in the same Gmail thread.
- Any errors, exact text, and whether the issue is config, runtime, or provider-side.

## Stop Conditions

- Do not enable auto-reply for a real inbox on the first pass.
- Do not use a primary mailbox if OAuth/app-password risk is unacceptable.
- If OAuth config is missing, do not keep retrying sign-in; switch to app-password fallback or fix env first.
- If outbound replies mis-thread or duplicate, stop and fix before broader testing.
