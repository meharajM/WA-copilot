# Email Channel Progress

## Goal
Track the email channel integration work in one place and keep the test plan reusable across sessions.

This document is a supporting implementation/status note.

For QA pass/fail expectations, treat [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md) as the primary source of truth.

## Architecture Summary
The repo’s main architecture doc is WhatsApp-oriented, but the email channel follows the same Electron split:

- Renderer owns the settings UI, Zustand store, and bridge hook.
- Main process owns the MCP email server spawn, polling, and outbound send path.
- IPC connects the renderer to the main process.
- Email sessions are mapped into chat sessions using deterministic thread keys.

Current flow:

1. User configures email settings in the renderer.
2. Renderer persists config and triggers `email:start`.
3. Main process starts `EmailChannelService`.
4. `EmailChannelService` spawns the MCP server through `uvx` or Gmail OAuth mode.
5. Inbound messages are normalized into email session messages only when `Auto-Reply` is enabled.
6. When `Auto-Reply` is off, inbound messages are ignored by the renderer bridge and do not create agent sessions.
7. Messages that pass the gate are routed into the chat runtime and persisted like other channels.
8. Outbound replies go through the email send tool path or Gmail API path.

Target behavior:

1. High-confidence, knowledge-grounded replies may send automatically when policy and settings allow it.
2. Low-confidence cases should send a short standard fallback reply to the customer.
3. The same low-confidence case should create an in-app reminder or notification for owner follow-up.

Current gap to target:

- The current implementation already supports confidence-based send vs draft vs escalate.
- It does not yet guarantee the target fallback flow of generic acknowledgement plus explicit owner reminder/notification on low-confidence email outcomes.

## Relevant Files

- [architecture.md](/Users/meharaj/WA-copilot/architecture.md)
- [email-integration.md](/Users/meharaj/WA-copilot/email-integration.md)
- [src/renderer/src/components/settings/EmailSettingsPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/EmailSettingsPanel.tsx)
- [src/renderer/src/hooks/useEmailBridge.ts](/Users/meharaj/WA-copilot/src/renderer/src/hooks/useEmailBridge.ts)
- [src/main/services/EmailChannelService.ts](/Users/meharaj/WA-copilot/src/main/services/EmailChannelService.ts)
- [src/main/utils/DependencyService.ts](/Users/meharaj/WA-copilot/src/main/utils/DependencyService.ts)
- [scripts/setup-dependencies.sh](/Users/meharaj/WA-copilot/scripts/setup-dependencies.sh)

## How To Test The Email Integration

### 1. Dependency check
Confirm the app can see `uv`/`uvx`, Python, Node, and ffmpeg.

Use the app’s dependency screen or run the setup script:

- Open `Settings -> About` or the missing-dependencies screen.
- Run the install script if `uv` is missing.
- Reopen the app if the GUI PATH was stale.

### 2. Email settings connection test
Use `Settings -> Email Channel -> Test Connection`.

What it checks:

- Provider selection and mailbox fields.
- Secure password storage.
- MCP email server startup.
- Immediate poll result.

Expected result:

- `Connection successful. You can now enable the email channel.`

### 3. Local automated tests
Run the repo’s deterministic test layers:

- `npm run typecheck`
- `npm run test:unit`
- `npm run test:integration`

Email-specific coverage currently lives in:

- `tests/unit/email-integration.test.ts`
- `tests/unit/email-bridge.test.ts`
- `tests/unit/email-gmail.test.ts`
- `tests/unit/email-policy.test.ts`
- `tests/integration/email-integration.test.ts`
- `tests/integration/email-confidence-gating.test.ts`

### 4. Live contract tests
Run the live suite with real provider access:

- `npm run test:live`

This validates:

- OpenRouter provider access.
- Tool-call parsing and recovery.
- Email-specific live scenarios in `tests/live/openrouter.live.test.ts`.

### 5. Manual smoke test
If you want a true end-to-end email smoke test:

- Configure a real mailbox.
- Run `Test Connection`.
- Enable the email channel from the UI.
- Turn `Auto-Reply` on if you expect inbound email to become a session.
- Send a test message from an external mailbox.
- Confirm the message becomes a session only when `Auto-Reply` is on.
- Confirm the assistant response is drafted, escalated, or sent according to current policy and `Draft Mode`.

## Current Work Status

- The `uvx ENOENT` failure was traced to the runtime spawn path, not the dependency installer itself.
- `EmailChannelService` now expands PATH before spawning the MCP server.
- The error now includes a clearer hint when `uvx` is still unavailable to the Electron process.

## Next Things To Verify

1. Confirm the email settings screen shows dependency failures clearly when `uvx` is not on PATH.
2. Confirm the install script launches when required dependencies are missing.
3. Confirm the email channel can start with a real mailbox after the PATH fix.
4. Consider adding a dedicated email dependency preflight in the renderer before `email:start`.
