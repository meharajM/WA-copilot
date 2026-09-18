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

Current policy behavior:

1. High-confidence, knowledge-grounded replies may send automatically when policy and settings allow it.
2. Low-confidence, non-sensitive cases send one standard acknowledgement to the customer.
3. The generated response becomes an escalated Drafts-panel review item for owner follow-up.
4. Sensitive and do-not-contact cases never auto-send an acknowledgement.
5. The runtime owns each delivery once: an agent tool send and post-response delivery cannot both send the same response.

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
- `npm run test:e2e`

Email-specific coverage currently lives in:

- `tests/unit/email-integration.test.ts`
- `tests/unit/email-bridge.test.ts`
- `tests/unit/email-gmail.test.ts`
- `tests/unit/email-policy.test.ts`
- `tests/unit/email-agent-delivery.test.ts`
- `tests/unit/email-channel-service.test.ts`
- `tests/integration/email-integration.test.ts`
- `tests/integration/email-confidence-gating.test.ts`

### 4. Live contract tests
Run the live suite with real provider access:

- `npm run test:live`

This validates:

- OpenRouter provider access.
- Tool-call parsing and recovery.
- Generic and WhatsApp tool-call scenarios in `tests/live/openrouter.live.test.ts`.

The live OpenRouter suite does not replace the dedicated-mailbox email QA flow.

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

### Browser/agentd inbound slice

Browser mode now exposes an authenticated, durable email ingress contract:

- `POST /api/v1/email/inbound` accepts a normalized inbound event and persists it in agentd SQLite.
- `providerEventId` is unique per email channel; retries return `duplicate: true` without creating another row.
- `GET /api/v1/email/inbound?after_id=<id>&limit=<n>` reads queued events with a bounded cursor page (`n` capped at 50).
- Payloads are bounded and require sender, body, body type, and timestamp. Credentials never enter the event payload.

This slice stores real normalized events for a browser-side provider/poller to consume. It does not claim IMAP polling or Gmail OAuth parity; native Electron remains owner of those transports.

When the browser Email channel is enabled and Auto-Reply is explicitly on, the browser polls this bounded cursor, creates or reuses the deterministic agentd-backed email session, and appends the normalized message once. With Auto-Reply off, events remain durable and the UI reports that they are stored but gated; they are not silently routed into an agent session. This is an ingress/session-continuity slice only: there is still no browser IMAP/Gmail worker, outbound delivery, draft approval/send path, or browser-side credential read.

- The `uvx ENOENT` failure was traced to the runtime spawn path, not the dependency installer itself.
- `EmailChannelService` now expands PATH before spawning the MCP server.
- The error now includes a clearer hint when `uvx` is still unavailable to the Electron process.
- Sensitive-topic policy checks the inbound request as well as the generated response.
- Low-confidence acknowledgements and owner review drafts are implemented.
- Production email bridge and channel-service behavior have focused automated coverage.

## Next Things To Verify

1. Confirm the email settings screen shows dependency failures clearly when `uvx` is not on PATH.
2. Confirm the install script launches when required dependencies are missing.
3. Confirm the email channel can start with a real mailbox after the PATH fix.
4. Consider adding a dedicated email dependency preflight in the renderer before `email:start`.
