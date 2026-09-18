# App Behavior Validation

Last updated: 2026-09-18

## Purpose

This document validates [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md) against the current codebase and nearby supporting docs.

It answers three questions:

- Is `docs/app-behavior.md` accurate enough to act as the primary QA contract?
- Which surrounding docs drift from the current implementation?
- Which product decisions still need clarification before the broader doc set is cleaned up?

## Verdict

`docs/app-behavior.md` is currently the best source of truth for QA.

It should be treated as a shared contract for both testers and developers.

The 2026-09-18 audit found and corrected browser Email drift: the contract now distinguishes daemon mailbox ingestion from browser review-session hydration, explicitly excludes automatic browser replies, and documents the transport-specific credential slots plus the legacy fallback.

The main problems are in older support docs that still describe:

- WhatsApp-only session assumptions
- a single master "Bot Mode" concept
- Brain View as a combined memory-plus-RAG inspection surface
- email inbound behavior as if passive monitoring always creates sessions

## Validation Scope

### Code checked

- [src/renderer/src/hooks/useEmailBridge.ts](/Users/meharaj/WA-copilot/src/renderer/src/hooks/useEmailBridge.ts)
- [src/renderer/src/components/SettingsPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/SettingsPanel.tsx)
- [src/renderer/src/components/chat/KnowledgeBrowser.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/chat/KnowledgeBrowser.tsx)
- [src/renderer/src/components/chat/LeadDirectory.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/chat/LeadDirectory.tsx)
- [src/renderer/src/components/settings/MemoryPreferencesPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/MemoryPreferencesPanel.tsx)
- [src/renderer/src/components/settings/llm/OpenAISettings.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/llm/OpenAISettings.tsx)

### Docs checked

- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md)
- [docs/tester_install.html](/Users/meharaj/WA-copilot/docs/tester_install.html)
- [docs/email-channel-progress.md](/Users/meharaj/WA-copilot/docs/email-channel-progress.md)
- [architecture.md](/Users/meharaj/WA-copilot/architecture.md)

### Test surface checked

- `npm run typecheck`
- `npm run test:unit`
- `npm run test:integration`
- `npm run build`

These were already run successfully in the current repo state before this validation summary was written.

## Confirmed Alignment

### Email gating and Gmail behavior

`docs/app-behavior.md` correctly describes the current email behavior:

- Gmail can run in local IMAP/SMTP mode without Google OAuth.
- Google OAuth is only used when Gmail auth mode is set to Google sign-in and OAuth is actually connected.
- Daemon-ingested inbound email remains queued when `Auto-Reply` is off; when it is on, the browser hydrates a review session but does not run automatic reply generation.
- Browser app-password writes use agentd's `email_imap_password` and `email_smtp_password` slots; `email_mcp_password` is retained only as a read-only continuity fallback.

Evidence:

- [src/renderer/src/hooks/useEmailBridge.ts](/Users/meharaj/WA-copilot/src/renderer/src/hooks/useEmailBridge.ts):33
- [src/renderer/src/hooks/useEmailBridge.ts](/Users/meharaj/WA-copilot/src/renderer/src/hooks/useEmailBridge.ts):83
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):196
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):214

### WhatsApp control model

`docs/app-behavior.md` correctly describes the current split between:

- `Autonomous Bot Mode`
- `Response Permission`

Evidence:

- [src/renderer/src/components/SettingsPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/SettingsPanel.tsx):163
- [src/renderer/src/components/SettingsPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/SettingsPanel.tsx):179
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):149

### Brain View vs memory settings

`docs/app-behavior.md` correctly separates:

- Brain View for indexed knowledge documents
- Knowledge Base settings for memory backend, stats, migration, and inspector

Evidence:

- [src/renderer/src/components/chat/KnowledgeBrowser.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/chat/KnowledgeBrowser.tsx):13
- [src/renderer/src/components/settings/MemoryPreferencesPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/MemoryPreferencesPanel.tsx):15
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):254
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):271

### Omnichannel lead directory

`docs/app-behavior.md` correctly describes Lead Directory as session-backed and omnichannel-capable, while also noting that some UI copy remains WhatsApp-heavy.

Evidence:

- [src/renderer/src/components/chat/LeadDirectory.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/chat/LeadDirectory.tsx):10
- [src/renderer/src/components/chat/LeadDirectory.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/chat/LeadDirectory.tsx):19
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):287
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):416

## Doc Drift Findings

### Finding 1: `docs/tester_install.html` is materially stale

Severity: medium

The HTML tester manual still presents an older product model in several places:

- `All Chats` is described as active WhatsApp-only sessions, but the runtime/session model is now omnichannel.
- `Lead Directory` is described as auto-extracting customer names, phone numbers, and lead status in a stronger CRM sense than the current table actually implements.
- `Brain View` is described as showing both memory logs and RAG indexed files, but memory inspection now lives under Knowledge Base settings.
- The app is described as having a single `Bot Mode` switch, but the running UI exposes separate autonomy and send-permission toggles.
- OpenRouter setup refers to a `Verify Connection` button, while the current card label is `Test Connection & Fetch Models`.

Evidence:

- [docs/tester_install.html](/Users/meharaj/WA-copilot/docs/tester_install.html):88
- [docs/tester_install.html](/Users/meharaj/WA-copilot/docs/tester_install.html):96
- [docs/tester_install.html](/Users/meharaj/WA-copilot/docs/tester_install.html):104
- [docs/tester_install.html](/Users/meharaj/WA-copilot/docs/tester_install.html):143
- [docs/tester_install.html](/Users/meharaj/WA-copilot/docs/tester_install.html):169
- [src/renderer/src/components/SettingsPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/SettingsPanel.tsx):163
- [src/renderer/src/components/SettingsPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/SettingsPanel.tsx):179
- [src/renderer/src/components/settings/llm/OpenAISettings.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/llm/OpenAISettings.tsx):96

### Finding 2: `docs/email-channel-progress.md` overstates inbound-email behavior (resolved)

Severity: medium

The progress note describes the email flow as if inbound messages are always normalized into sessions once the channel is running. That is not the current implementation.

The supporting progress note previously implied that polling itself created browser sessions. It now records the actual boundary: polling queues daemon events, while the browser creates a review session only when:

- Email channel is enabled, and
- `Auto-Reply` is on; no automatic browser reply is generated by this consumer.

Evidence:

- [docs/email-channel-progress.md](/Users/meharaj/WA-copilot/docs/email-channel-progress.md):20
- [docs/email-channel-progress.md](/Users/meharaj/WA-copilot/docs/email-channel-progress.md):84
- [src/renderer/src/hooks/useEmailBridge.ts](/Users/meharaj/WA-copilot/src/renderer/src/hooks/useEmailBridge.ts):33
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):216

### Finding 3: `architecture.md` still describes the pre-split WhatsApp model

Severity: low

The architecture overview still describes:

- `useChatStore` as WhatsApp-JID-centric
- `useWhatsAppStore` as exposing a single master `Bot Mode`
- inbound agent triggering as a single-switch decision

That was likely correct earlier, but it is no longer the best description of the current product contract.

Evidence:

- [architecture.md](/Users/meharaj/WA-copilot/architecture.md):85
- [architecture.md](/Users/meharaj/WA-copilot/architecture.md):86
- [architecture.md](/Users/meharaj/WA-copilot/architecture.md):105
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):72
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):149

## Recommended Source-of-Truth Order

Until the older docs are cleaned up, use this order:

1. [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md)
2. Current implementation in renderer/main code
3. Focused progress docs such as [docs/email-channel-progress.md](/Users/meharaj/WA-copilot/docs/email-channel-progress.md), but only after checking them against the behavior contract
4. Older narrative/manual docs such as [docs/tester_install.html](/Users/meharaj/WA-copilot/docs/tester_install.html)

## Resolved Direction

The product/documentation direction is now:

1. The canonical behavior doc is for both testers and developers.
2. Low-confidence non-sensitive email handling now implements the documented acknowledgement plus owner-review flow.
3. Older support docs should be updated to the new behavior rather than preserved as-is.

## Follow-through Applied

The following docs were updated after this validation:

- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md)
- [docs/tester_install.html](/Users/meharaj/WA-copilot/docs/tester_install.html)
- [docs/email-channel-progress.md](/Users/meharaj/WA-copilot/docs/email-channel-progress.md)
- [architecture.md](/Users/meharaj/WA-copilot/architecture.md)
