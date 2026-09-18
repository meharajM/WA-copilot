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

The follow-up runtime-boundary audit also corrected the launch contract: Edge/Chrome has an explicit agentd readiness/pairing state machine, while the Electron dependency modal is no longer described as a browser startup requirement. Gemini is covered by the browser agentd provider slice, and explicit on-device/WebGPU execution is now available in the browser without changing the Tauri native-only boundary.

The main problems are in older support docs that still describe:

- WhatsApp-only session assumptions
- a single master "Bot Mode" concept
- Brain View as a combined memory-plus-RAG inspection surface
- email inbound behavior as if passive monitoring always creates sessions

## Validation Scope

### Code checked

- [src/renderer/src/BrowserProduct.tsx](/Users/meharaj/WA-copilot/src/renderer/src/BrowserProduct.tsx)
- [src/renderer/src/components/SystemDependenciesSettings.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/SystemDependenciesSettings.tsx)
- [src/renderer/src/components/settings/llm/LLMProviderSettings.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/llm/LLMProviderSettings.tsx)
- [src/renderer/src/components/settings/llm/BrowserLLMSettings.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/llm/BrowserLLMSettings.tsx)
- [src/renderer/src/hooks/useLLMStatus.ts](/Users/meharaj/WA-copilot/src/renderer/src/hooks/useLLMStatus.ts)
- [src/renderer/src/lib/llm/browser-llm.ts](/Users/meharaj/WA-copilot/src/renderer/src/lib/llm/browser-llm.ts)
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
- `npm run lint` (0 errors; existing warnings only)
- `node --test tests/unit/*.test.cjs` (103 passed, 2 Windows-only skips)
- `npm run typecheck:renderer`
- `npm run build:tauri:web -- --emptyOutDir`
- `cargo test --manifest-path src-tauri/Cargo.toml --locked` (19 passed)
- `node scripts/verify-tauri-resources.mjs --sidecar-root src-tauri/sidecar --ui-root dist --platform darwin --target-triple aarch64-apple-darwin`
- `npm exec vitest run tests/integration/llm-routing.test.ts tests/unit/tauri-ui-boundary.test.ts tests/unit/browser-agentd-client.test.ts`
- `node --test tests/unit/agentd.test.cjs tests/unit/agentd-chat-generations.test.cjs tests/unit/agentd-settings-persona.test.cjs`

The current run completed these checks successfully; build tools emitted only their existing warnings.

### Real-user browser smoke

On 2026-09-18, the browser entry was opened at `http://127.0.0.1:5173/tauri.html?workspace=1` with no local daemon available. The UI showed `AICA / BROWSER WORKSPACE`, `Local service unavailable`, and `Retry connection`; activating retry kept the same fail-closed state and did not mount the product workspace. This passes the unavailable-service contract. Pairing and full workspace navigation require a running owner-supervised agentd instance and were not claimed by this smoke.

## Confirmed Alignment

### Browser startup and native-host boundary

`BrowserProduct` checks the authenticated local daemon before lazy-loading the product `App`. It renders a loading state, an explicit unavailable/retry state, or a one-time pairing form; it does not start the daemon and does not render product UI in the Tauri host. `SystemDependenciesSettings` independently skips Electron host-tool inspection in browser mode.

Evidence:

- [src/renderer/src/BrowserProduct.tsx](/Users/meharaj/WA-copilot/src/renderer/src/BrowserProduct.tsx):25
- [src/renderer/src/tauri-main.tsx](/Users/meharaj/WA-copilot/src/renderer/src/tauri-main.tsx):8
- [src/renderer/src/components/SystemDependenciesSettings.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/SystemDependenciesSettings.tsx):8
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):74

### Browser LLM provider boundary

The browser settings component exposes `auto`, Ollama, OpenAI/Compatible, Gemini, OpenRouter, and an explicit On-Device/WebGPU card. Browser credentials, remote provider tests, generation and streaming use authenticated agentd routes; Gemini model discovery is daemon-backed. The WebGPU card downloads only after an explicit user action, persists the selected model as a product preference, and routes generation through the existing browser WebLLM worker. The agentd `browser` preference is persistence-only and fails closed if it ever reaches the server generation route.

Evidence:

- [src/renderer/src/components/settings/llm/LLMProviderSettings.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/llm/LLMProviderSettings.tsx):69
- [src/renderer/src/components/settings/llm/BrowserLLMSettings.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/llm/BrowserLLMSettings.tsx):1
- [src/renderer/src/lib/browser-agentd-client.ts](/Users/meharaj/WA-copilot/src/renderer/src/lib/browser-agentd-client.ts):251
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):438

The Gemini browser slice was then verified independently: a fake-provider daemon test covered the fixed models probe, `x-goog-api-key` non-disclosure boundary, text/image request shape, non-streaming response parsing, SSE deltas, durable completion and retry-safe generation rows. No real Google credential was used.

The WebGPU slice is covered by renderer routing and boundary tests plus the existing WebLLM manager contract. Headless CI cannot prove a real Windows WebGPU adapter or multi-gigabyte model download; Windows acceptance still requires a user-granted Edge/Chrome WebGPU smoke that downloads the lightweight model, selects it, completes a prompt, verifies the model remains cached after reload, and confirms switching back to `auto` uses agentd.

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
