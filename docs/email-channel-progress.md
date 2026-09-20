# Email Channel Progress

## Goal
Track the email channel integration work in one place and keep the test plan reusable across sessions.

This document is a supporting implementation/status note.

For QA pass/fail expectations, treat [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md) as the primary source of truth.

## Architecture Summary
The repo’s main architecture doc is WhatsApp-oriented. Email currently has two explicit runtime paths:

- Electron owns the legacy/native path: renderer settings, the Zustand store and bridge hook; the main process owns MCP email-server spawn, IMAP/Gmail polling and outbound delivery; IPC connects those layers.
- Browser mode owns the migrated agentd slice: authenticated settings/credential writes, bounded secure-transport probes, daemon-owned app-password IMAP MIME or signed-in Gmail API polling, private scanned media retrieval for small safe images, gated SMTP/Gmail API delivery for approved drafts with optional bounded operator-selected attachments, queued inbound-event consumption, and durable draft/session records. Custom MCP and unsupported providers remain unavailable. When a Gmail OAuth session expires or is revoked, agentd reports reauthentication and the browser requires a fresh sign-in.
- Both paths map email sessions into chat sessions using deterministic thread keys.

Electron flow:

1. User configures email settings in the renderer.
2. Renderer persists config and triggers `email:start`.
3. Main process starts `EmailChannelService`.
4. `EmailChannelService` spawns the MCP server through `uvx` or Gmail OAuth mode.
5. Inbound messages are normalized into email session messages only when `Auto-Reply` is enabled.
6. When `Auto-Reply` is off, inbound messages are ignored by the renderer bridge and do not create agent sessions.
7. Messages that pass the gate are routed into the chat runtime and persisted like other channels.
8. Outbound replies go through the email send tool path or Gmail API path.

Browser flow:

1. User configures settings in Edge/Chrome.
2. The browser persists non-secret settings and write-only credentials through authenticated agentd routes. Form writes are serialized and flushed before Test Connection or Save Setup reports success, so rapid edits cannot restore stale settings.
3. `Test Connection` runs a bounded IMAP/SMTP transport probe; the daemon mailbox worker separately starts only when Enable, app-password, IMAP TLS/host, and OS-credential gates pass.
4. The daemon polls bounded MIME-aware IMAP or Gmail API messages using durable cursors and queues normalized inbound events; the browser claims them only when `Enable Email Channel` and `Auto-Reply` are both on. Small scanned images can be hydrated through authenticated media routes; larger/unsupported files remain metadata-only.
5. Browser drafts, generation policy and session records remain agentd-owned. `Auto-Reply` runs the authenticated browser generation/confidence path and acknowledges only after policy handling; native file/credential operations remain outside the browser slice. Approved SMTP/Gmail drafts use the daemon route, with optional bounded operator-selected attachments.

Policy behavior:

1. Electron retains the legacy client-side confidence/delivery policy; browser agentd applies the same bounded policy after authenticated generation.
2. High-confidence, knowledge-grounded replies may send automatically when policy and settings allow it.
3. Low-confidence, non-sensitive cases send one standard acknowledgement to the customer and retain the generated response as a Drafts-panel review item.
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

Electron checks:

- Provider selection and mailbox fields.
- Secure password storage.
- MCP email server startup.
- Immediate poll result.

Expected Electron result:

- `Connection successful. You can now enable the email channel.`

Browser checks:

- Provider selection and mailbox fields.
- Authenticated agentd settings and write-only credential persistence.
- Bounded secure IMAP/SMTP transport reachability.

Expected browser result:

- `Secure transport reachable ...` with bounded IMAP/SMTP TLS diagnostics and no credential values.
- The browser must distinguish transport reachability from the separately gated mailbox poller and approved-draft SMTP send.

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

- Electron: configure a real mailbox, run `Test Connection`, enable the channel, and verify a real inbound message and policy-controlled response.
- Browser: verify settings/credential persistence and the bounded transport probe, then use an authorized app-password IMAP or Gmail OAuth test mailbox. Confirm bounded text/MIME messages queue through the daemon cursor and become a session only when both `Enable Email Channel` and `Auto-Reply` are on; verify small safe images hydrate while larger/unsupported files stay metadata-only, then approve a draft with an optional safe attachment and verify the separately gated SMTP/Gmail route.

## Current Work Status

### Browser/agentd inbound slice

Browser mode now exposes an authenticated, durable email ingress contract:

- `POST /api/v1/email/inbound` accepts a normalized inbound event and persists it in agentd SQLite.
- `providerEventId` is unique per email channel; retries return `duplicate: true` without creating another row.
- `GET /api/v1/email/inbound?after_id=<id>&limit=<n>` reads queued events with a bounded cursor page (`n` capped at 50).
- Payloads are bounded and require sender, body, body type, and timestamp. Credentials never enter the event payload.

This slice stores real normalized events for the browser session consumer to consume. The daemon now owns the bounded app-password IMAP/SMTP and signed-in Gmail API paths; rich MIME/attachments and unsupported provider transports remain outside the browser slice.

When the browser Email channel is enabled and Auto-Reply is explicitly on, the browser claims this bounded queue, creates or reuses the deterministic agentd-backed email session, and appends the normalized message once. With Auto-Reply off, daemon-ingested events remain durable and the UI reports that they are stored but gated; they are not silently routed into an agent session. No browser LLM generation or automatic reply is triggered by this consumer. Approved drafts with optional bounded operator-selected attachments can use the separately gated daemon SMTP/Gmail route. This remains an ingress/session-continuity slice: provider delivery events and browser-side credential reads are still unavailable.

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
