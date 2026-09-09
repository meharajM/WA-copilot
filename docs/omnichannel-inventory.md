# Omnichannel ingress, egress and persistence inventory

Date: September 9, 2026

This is a repository-derived inventory of the current desktop pilot. It separates
autonomous main-process paths from explicit human/operator paths.

## Inbound paths

| Source | Entry point | Autonomous hand-off |
| --- | --- | --- |
| Baileys WhatsApp | `src/main/whatsapp/WhatsAppService.ts` emits `message`; `src/main/ipc/whatsapp.ts` registers the listener | `autonomousSupervisor.onMessage(message)` |
| WhatsApp Web | `src/main/services/WhatsAppWebConnector.ts` polls the dedicated browser profile; `src/main/ipc/whatsapp.ts` supplies the callback | `autonomousSupervisor.onMessage(message)` |
| WhatsApp Cloud API | `src/main/services/WhatsAppCloudWebhookServer.ts` verifies the signed webhook and calls `normalizeCloudWebhook` | `autonomousSupervisor.onMessage(message)` |
| Email via MCP/polling | `src/main/services/EmailChannelService.ts` emits normalized messages from polling/fallback fetch paths | `src/main/ipc/email.ts` calls `autonomousSupervisor.onEmailMessage(message)` |
| Email via Gmail API | `EmailChannelService.pollViaGmailApi()` normalizes Gmail messages and emits the same `message` event | Same email supervisor hand-off |
| Instagram/Messenger | `src/main/services/MetaWebhookServer.ts` verifies and normalizes the signed webhook | `autonomousSupervisor.onMetaMessage(message)` from `src/main/index.ts` |
| X direct messages | `src/main/services/XWebhookServer.ts` verifies and normalizes the signed webhook | `autonomousSupervisor.onMetaMessage(message)` from `src/main/index.ts` |
| Meta lead events | `MetaWebhookServer` normalizes leadgen events | `autonomousSupervisor.recordMetaLead(lead)`; attribution storage, not messaging consent |

All autonomous ingress is normalized through `ChannelMessage`, scoped to a
business and channel account, validated before queue admission, deduplicated by
provider/message identity, and persisted by `AutonomousSupervisor`.

There is currently no browser-extension bridge. The Web connector is a bounded
desktop connector with operator-supplied chat monitoring and manual takeover.

## Outbound senders

### Autonomous host path

`AutonomousSupervisor.processMessage()` is the only autonomous decision and
dispatch path. It sends through:

- `WhatsAppTransport` to `WhatsAppService.sendMessage()` for Baileys;
- `WhatsAppCloudApiTransport.sendText()` or `.sendTemplate()` for Cloud API;
- `MetaMessagingTransport.sendText()` for Instagram/Messenger;
- `XDirectMessageTransport.sendText()` for X DMs;
- `EmailChannelService.send()` for email.

The supervisor validates mode, permission, pause/takeover, consent, response
window, grounding, sensitivity, revision, caps, content bounds and transport
selection immediately before creating and claiming an outbound record. WhatsApp
Web intentionally returns a manual-only failure until live send semantics and
delivery reconciliation are verified.

### Explicit human/operator paths

These are not autonomous senders and must remain separately auditable:

- `src/main/ipc/whatsapp.ts` — `whatsapp:send-message` and media handlers;
- `src/main/ipc/email.ts` — `email:send`;
- `src/renderer/src/lib/whatsapp-integration.ts`, `ChatInput.tsx`, `useAgent.ts`,
  and `useResolutionAudit.ts` — explicit renderer actions that call the
  WhatsApp bridge;
- `src/main/ipc/mcp.ts` — allowlisted owner/operator MCP actions, including
  bounded WhatsApp sends;
- `src/main/packages/omnichannel/index.ts` — generic provider manager used by
  registered providers, not the autonomous supervisor’s dispatch authority.

Renderer `app:submit-message` events are UI workflow events. The email and
WhatsApp bridges route them to the main supervisor when it is authoritative;
legacy renderer handling remains only as a human/UI fallback when supervisor
state cannot be read.

## Customer-graph capability boundary

The autonomous graph in `src/main/services/AutonomyWorkflow.ts` accepts a
normalized message and a host-owned decision callback. It is not given the
renderer tool registry, MCP clients, Meta marketing APIs, or any generic
provider mutation interface. The repository contains no ad creation, budget,
audience, campaign, or boost adapter. Meta lead ingestion is read-only and
does not create messaging consent. Owner MCP controls are registered through
separate IPC authorization and are not reachable from customer content or the
autonomous graph.

## Persistence writers

### Autonomous state and audit

`src/main/services/AutonomousSupervisor.ts` writes the user-data
`autonomy.db` SQLite database. It owns inbound events, conversations, jobs,
channel accounts, consents, messages, graph runs, decisions, drafts,
outbound sends, delivery events, retries, operator actions, notifications,
usage, takeovers, metadata leads, schema migrations and the supervisor lease.
It also writes `autonomy-state.json` for mode, response permission, pause and
health state. This is the authoritative autonomous state writer.

### Chat/session persistence

`src/main/services/ChatPersistenceService.ts` writes
`chat_history.v2.db` sessions and session messages. Main IPC registration and
the renderer Zustand persistence bridge can call `saveSession`; the service
rejects stale snapshots and upserts message IDs rather than clearing a session.
This is UI chat history, not the autonomous outbox or decision ledger.

### Channel/provider state

- `src/main/whatsapp/WhatsAppService.ts` persists Baileys auth/session state and
  connection-related caches in the user-data area.
- `src/main/services/EmailChannelService.ts` persists seen-message IDs and Gmail
  sync cursors in its `electron-store` state.
- `src/main/services/WhatsAppTransport.ts`, `src/main/ipc/whatsapp.ts`, and
  `src/main/ipc/store.ts` use `electron-store` for selected transport and app
  settings.
- `src/main/ipc/secure.ts` and `GmailOAuthService.ts` store encrypted or
  keychain-backed secrets; OAuth tokens are not autonomous conversation state.
- `src/main/services/McpAudit.ts` writes MCP authorization/tool audit records.

### Permission and control writers

`AutonomousSupervisor.setMode()` and its pause/resume/takeover/approval methods
write the durable operator-action ledger and `autonomy-state.json`. Renderer
localStorage/Zustand writes UI preferences and cached session state only; they
do not grant autonomous response permission. Main-process policy is the final
authority.

## Known inventory limits

This inventory proves current code paths and ownership; it does not prove live
provider permissions, webhook reachability, delivery reconciliation, OAuth
scope compliance, or packaged-app behavior. Those remain explicit release and
pilot gates in the implementation checklist.
