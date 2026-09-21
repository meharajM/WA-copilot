# App Behavior Validation

Last updated: 2026-09-22

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

The follow-up runtime-boundary audit also corrected the launch contract: Edge/Chrome has an explicit agentd readiness/pairing state machine, while the Electron dependency modal is no longer described as a browser startup requirement. Gemini is covered by the browser agentd provider slice, and explicit on-device/WebGPU execution is now available in the browser without changing the Tauri native-only boundary. WhatsApp browser UI state now lives in authenticated agentd settings with a one-time legacy renderer migration; the autonomous flag is never persisted or restored, and browser ingress remains gated only by Response Permission. Windows native diagnostics now includes an owner-triggered, least-privilege per-user sign-in service registration with bounded failure restart settings. Windows package run [35528078107](https://github.com/meharajM/WA-copilot/actions/runs/35528078107) and full PR gate [35528078104](https://github.com/meharajM/WA-copilot/actions/runs/35528078104) passed staged resource verification, migration-reader reparse smoke, packaged Credential Manager round-trip smoke, native Rust host tests, Task Scheduler registration, and installer verification; signing, install/upgrade, and full parity evidence remain release gates.

The 2026-09-20 WhatsApp follow-up audit moved inactivity resolution into agentd. Durable active sessions are swept every minute after ten minutes of silence; review mode creates one deterministic draft, Autonomous Bot Mode uses the existing approved outbox, and customer-last silence is logged once. Browser-side timers are disabled, so tab closure/reload cannot drop or duplicate follow-ups.

The older support-doc drift identified by the first audit is now corrected in the checked-in HTML manuals, email progress note, and architecture overview. The code-first follow-up also corrected `docs/tester_flow.html`, which had incorrectly presented the legacy Electron flow, PDF ingestion, and Browser MCP/Playwright as browser capabilities. The browser MCP boundary is now a supervised agentd worker for approved external servers; internal/native command definitions remain fail-closed. Browser PDF/Office/document ingestion now uses the same supervised agentd boundary with bounded conversion output and explicit failure states. The native companion now supervises and restarts a child daemon that it started, while still preserving the independent daemon lifetime. Explicit Windows per-user service registration is implemented; installer enrollment, recovery after intentional user quit, and Windows release evidence remain implementation gates, not competing product-contract descriptions.

The 2026-09-21 browser-storage hardening removed the last generic `electron.store` renderer-local fallback. Electron continues delegating to its native store; Edge/Chrome calls now return defaults or fail closed with an explicit agentd-owned-storage error, while product settings remain persisted through authenticated agentd routes. Focused boundary tests, 348 unit tests, renderer typecheck, and browser pairing/reload E2E passed after this change. The current release gate also runs the dedicated agentd speech-model suite, which covers streaming cache writes and integrity/size/allowlist failures.

The current branch head `a1d42686` also passed Windows full workflow [35638480401](https://github.com/meharajM/WA-copilot/actions/runs/35638480401) and package workflow [35638480307](https://github.com/meharajM/WA-copilot/actions/runs/35638480307). Those runs provide unsigned bundle/install/resource evidence; signing, real-profile continuity and live provider/Web validation remain release gates.

The 2026-09-21 real-user autonomy pass found and fixed two browser gaps. Approved-template controls were present in the shared panel but had no browser registry/send authority; authenticated agentd registry, Cloud template payloads, service-window/stale-inbound/utility-template gates, and durable idempotent outbox dispatch now back those controls. The same pass found that a rejected template send surfaced as an unhandled browser page error with no operator feedback; the panel now catches the rejection and renders a status message. A disposable Playwright flow paired the browser, opened Settings → Autonomous Supervisor, loaded an approved draft/template selector, clicked Send template with non-Cloud transport, showed the visible failure message, and produced no page errors. A DELETE-body socket-reset regression was also reproduced and fixed by consuming revoke requests before the next browser request.

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
- [src/renderer/src/components/chat/EmptyState.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/chat/EmptyState.tsx)
- [src/renderer/src/components/chat/LeadDirectory.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/chat/LeadDirectory.tsx)
- [src/renderer/src/components/settings/MemoryPreferencesPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/MemoryPreferencesPanel.tsx)
- [src/renderer/src/components/settings/llm/OpenAISettings.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/llm/OpenAISettings.tsx)
- [src/renderer/src/stores/settingsStore.ts](/Users/meharaj/WA-copilot/src/renderer/src/stores/settingsStore.ts)

### Docs checked

- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md)
- [docs/tester_install.html](/Users/meharaj/WA-copilot/docs/tester_install.html)
- [docs/tester_flow.html](/Users/meharaj/WA-copilot/docs/tester_flow.html)
- [docs/email-channel-progress.md](/Users/meharaj/WA-copilot/docs/email-channel-progress.md)
- [architecture.md](/Users/meharaj/WA-copilot/architecture.md)
- [agentd/whatsapp-baileys.cjs](/Users/meharaj/WA-copilot/agentd/whatsapp-baileys.cjs)
- [src/renderer/src/hooks/useWhatsAppBridge.ts](/Users/meharaj/WA-copilot/src/renderer/src/hooks/useWhatsAppBridge.ts)
- [src/renderer/src/NativeHostDiagnostics.tsx](/Users/meharaj/WA-copilot/src/renderer/src/NativeHostDiagnostics.tsx)
- [src/renderer/src/lib/tauri-native-bridge.ts](/Users/meharaj/WA-copilot/src/renderer/src/lib/tauri-native-bridge.ts)
- [src/renderer/src/stores/whatsappStore.ts](/Users/meharaj/WA-copilot/src/renderer/src/stores/whatsappStore.ts)
- [src/renderer/src/lib/browser-agentd-client.ts](/Users/meharaj/WA-copilot/src/renderer/src/lib/browser-agentd-client.ts)
- [agentd/server.cjs](/Users/meharaj/WA-copilot/agentd/server.cjs)
- [agentd/mcp-worker.cjs](/Users/meharaj/WA-copilot/agentd/mcp-worker.cjs)

### Test surface checked

- `npm run typecheck`
- `npm run test:unit`
- `npm run test:integration`
- `npm run build`
- `npm run lint` (0 errors; existing warnings only)
- `node --test tests/unit/*.test.cjs` (103 passed, 2 Windows-only skips)
- `node --test tests/unit/windows-keyring-runtime.test.cjs tests/unit/windows-migration-reader-runtime.test.cjs` on the Windows package runner (Credential Manager and reparse smokes passed)
- `npm run typecheck:renderer`
- `npm run build:tauri:web -- --emptyOutDir`
- `cargo test --manifest-path src-tauri/Cargo.toml --locked` (19 passed)
- `node scripts/verify-tauri-resources.mjs --sidecar-root src-tauri/sidecar --ui-root dist --platform darwin --target-triple aarch64-apple-darwin`
- `npm exec vitest run tests/integration/llm-routing.test.ts tests/unit/tauri-ui-boundary.test.ts tests/unit/browser-agentd-client.test.ts`
- `npx vitest run tests/unit/whatsapp-browser-persistence.test.ts`
- `node --test tests/unit/agentd-knowledge.test.cjs`
- `node --test tests/unit/agentd.test.cjs tests/unit/agentd-chat-generations.test.cjs tests/unit/agentd-settings-persona.test.cjs`
- `node --test tests/unit/agentd-whatsapp-drafts.test.cjs` (11 passed, including browser approved-template registry/send and revoke-request sequencing)
- `npx vitest run tests/unit/browser-agentd-client.test.ts tests/unit/tauri-ui-boundary.test.ts` (focused browser client/UI boundary checks)
- `npm run test:e2e:browser` (browser pairing/workspace/reload smoke)
- `cargo test --manifest-path src-tauri/Cargo.toml --locked` also covers the native supervisor build and descriptor ownership guards; the supervisor restart loop is conservative and target-specific Windows runtime behavior still requires the Windows runner.
- On Windows, the same Rust test binary additionally registers, queries, and removes a disposable current-user Task Scheduler definition; macOS/Linux runs validate XML escaping and the fixed native command boundary without claiming Windows runtime behavior.

The current run completed these checks successfully; build tools emitted only their existing warnings.

### Follow-up memory-boundary audit

The code-first review found that the browser preference schema still accepted the
Electron-only `server-memory` label even though agentd's memory routes always use
the daemon-owned SQLite tables (`backend: agentd-sqlite`). The route now accepts
that legacy value only as a compatibility input and canonicalizes it to `sqlite`
before persistence/response. The browser settings copy also distinguishes this
fixed browser backend from Electron's compatibility choice. This keeps a stale
profile from reporting a backend that the browser cannot actually instantiate.

Evidence:

- [agentd/server.cjs](/Users/meharaj/WA-copilot/agentd/server.cjs): `parseProductPreferences` and `memoryStatsValue`
- [src/renderer/src/components/settings/MemoryPreferencesPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/settings/MemoryPreferencesPanel.tsx): browser-specific backend copy
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md): browser/Electron memory backend contract

The same code-first pass found a browser auth boundary defect: Firebase sign-in
called the Electron-only scoped secret loader even though browser credentials
are write-only through authenticated agentd. `loadUserSecrets` now short-circuits
in browser mode, clears renderer key placeholders, and leaves provider
credential resolution to the daemon. This avoids an Electron IPC attempt in
Edge/Chrome and preserves the no-secret-in-renderer contract.

The autonomy review also found that the browser compatibility adapter exposed
one-shot agentd controls but a no-op state subscription. The adapter now polls
the authenticated status projection while the panel is mounted, cleans up its
timer on unmount, and leaves Electron's native event subscription unchanged.

The Email review then found that browser Auto-Reply stopped after session
hydration and never entered the generation/confidence-policy path. Browser
inbound handling now dispatches a completion-aware event, runs generation
through the authenticated agentd chat route, applies the existing sensitive /
low-confidence draft policy, and uses only the authenticated approved-draft
send route. The inbound event is acknowledged only after that work completes;
Electron's local Email bridge remains unchanged.

### Real-user browser smoke

On 2026-09-18, the browser entry was opened at `http://127.0.0.1:5173/tauri.html` with no local daemon available. The UI showed `AICA / BROWSER WORKSPACE`, `Local service unavailable`, and `Retry connection`; activating retry kept the same fail-closed state and did not mount the product workspace. This passes the unavailable-service contract. Pairing and full workspace navigation require a running owner-supervised agentd instance and were not claimed by this smoke.

The same audit also ran an isolated owner-supervised agentd on a temporary loopback port with a disposable pairing code. The browser pairing form accepted the one-time code, mounted the full product workspace, navigated through the sidebar and Settings, and showed the explicit `On-Device (WebGPU)` provider card with user-initiated model-download controls. The in-app browser surface did not expose `navigator.gpu`, so no real WebGPU adapter or model download was claimed. The native Tauri surface showed diagnostics, service status, owner pairing, picker and credential-presence controls only; it did not mount the product workspace.

The follow-up real-user smoke used the current daemon-served bundle on a disposable loopback port. After pairing, Settings → Knowledge Base showed `Memory backend: agentd-sqlite`, disabled `Server Memory (desktop)` with the Electron-only explanation, and the browser-specific fixed-backend copy. `Test Write` incremented the memory entity count from 0 to 1; reloading the browser preserved that count and the dashboard's learned-facts metric. This proves the browser memory route and reload persistence on macOS; it does not claim Windows Credential Manager, packaged Windows, or Electron memory-backend migration evidence.

## Confirmed Alignment

### Browser startup and native-host boundary

`BrowserProduct` checks the authenticated local daemon before lazy-loading the product `App`. It renders a loading state, an explicit unavailable/retry state, or a one-time pairing form; it does not start the daemon and does not render product UI in the Tauri host. `SystemDependenciesSettings` independently skips Electron host-tool inspection in browser mode.

Evidence:

- [src/renderer/src/BrowserProduct.tsx](/Users/meharaj/WA-copilot/src/renderer/src/BrowserProduct.tsx):25
- [src/renderer/src/tauri-main.tsx](/Users/meharaj/WA-copilot/src/renderer/src/tauri-main.tsx):8
- [src/renderer/src/components/SystemDependenciesSettings.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/SystemDependenciesSettings.tsx):8
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):74

### Browser MCP boundary

The implementation was checked before updating the docs. Browser MCP access now
uses the paired agentd worker for bounded management and execution: the browser
can add, edit, remove, configure auto-connect, connect, disconnect, list tools,
call allowlisted tools, and cancel calls for approved external servers.
Environment values are never returned; supported credential names are resolved
inside the OS-backed daemon. Stdio is restricted to the approved `uvx` packages,
SSE/HTTP endpoints are validated, and schemas, arguments, results, timeouts and
rates are bounded. Legacy internal Playwright/filesystem/native definitions fail
closed rather than being proxied to the page. Electron retains its existing MCP
client during the transition, and Tauri exposes no generic MCP/native command
proxy.

Evidence:

- [agentd/server.cjs](/Users/meharaj/WA-copilot/agentd/server.cjs): MCP lifecycle and sanitized server routes
- [src/renderer/src/lib/browser-agentd-client.ts](/Users/meharaj/WA-copilot/src/renderer/src/lib/browser-agentd-client.ts): browser lifecycle/server validators
- [agentd/mcp-worker.cjs](/Users/meharaj/WA-copilot/agentd/mcp-worker.cjs): supervised transport/policy boundary, credential lookup, bounded calls and cancellation
- [src/renderer/src/stores/mcpStore.ts](/Users/meharaj/WA-copilot/src/renderer/src/stores/mcpStore.ts): browser state and mutations stay agentd-owned; Electron remains unchanged
- [src/renderer/src/components/SettingsPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/SettingsPanel.tsx): supervised-worker status and explicit unsupported-definition errors
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):395

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
- Browser email form writes are serialized and flushed before connection-test or save success is reported, preventing an out-of-order loopback response from restoring stale settings.

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

Browser Response Permission, Autonomous Bot Mode, and target-number state are loaded from and saved to authenticated agentd UI settings. The browser-only legacy copy is consulted once after pairing, then removed; Electron continues to use its existing renderer persistence path during the transition. Autonomous replies use the durable draft/outbox path and never call Electron IPC.

Evidence:

- [src/renderer/src/stores/whatsappStore.ts](/Users/meharaj/WA-copilot/src/renderer/src/stores/whatsappStore.ts):47
- [src/renderer/src/lib/browser-agentd-client.ts](/Users/meharaj/WA-copilot/src/renderer/src/lib/browser-agentd-client.ts):928
- [agentd/server.cjs](/Users/meharaj/WA-copilot/agentd/server.cjs):2719
- [tests/unit/whatsapp-browser-persistence.test.ts](/Users/meharaj/WA-copilot/tests/unit/whatsapp-browser-persistence.test.ts):9

The native diagnostics boundary also exposes only fixed service lifecycle commands. Windows registration targets the current signed-in user, writes a short-lived private XML definition, invokes the fixed `schtasks.exe` path with bounded arguments, and removes the temporary definition; no arbitrary executable, shell command, or browser-selected path is accepted.

Evidence:

- [src/renderer/src/NativeHostDiagnostics.tsx](/Users/meharaj/WA-copilot/src/renderer/src/NativeHostDiagnostics.tsx):43
- [src/renderer/src/lib/tauri-native-bridge.ts](/Users/meharaj/WA-copilot/src/renderer/src/lib/tauri-native-bridge.ts):17
- [src-tauri/src/main.rs](/Users/meharaj/WA-copilot/src-tauri/src/main.rs):446

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

## Historical Doc Drift Findings

### Finding 1: `docs/tester_install.html` was materially stale — resolved

Severity: medium

The HTML tester manual previously presented an older product model in several places. It now describes:

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

### Finding 3: `architecture.md` described the pre-split WhatsApp model — resolved

Severity: low

The architecture overview still describes:

- `useChatStore` as WhatsApp-JID-centric
- `useWhatsAppStore` as exposing a single master `Bot Mode`
- inbound agent triggering as a single-switch decision

The overview now documents separate Electron-transition and browser/agentd inbound flows, the browser response-permission gate, and the explicit browser limitations.

Evidence:

- [architecture.md](/Users/meharaj/WA-copilot/architecture.md):85
- [architecture.md](/Users/meharaj/WA-copilot/architecture.md):86
- [architecture.md](/Users/meharaj/WA-copilot/architecture.md):105
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):72
- [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md):149

### Finding 4: `docs/tester_flow.html` described legacy Electron behavior as browser behavior — resolved

Severity: high

The technical reference called the application an Electron-first product, listed
PDF ingestion as browser-ready, and marked Browser MCP/Playwright as a beta
feature. The current browser implementation instead uses Edge/Chrome with a
paired local `agentd` service; browser knowledge ingestion is bounded to the
document types and conversion limits listed in the behavior contract, and MCP execution is available
only through the supervised approved-server policy. Internal Playwright/native
definitions remain unavailable. The manual now labels the transition boundary
and uses the current browser/agentd behavior.

Evidence:

- [docs/tester_flow.html](/Users/meharaj/WA-copilot/docs/tester_flow.html):123
- [docs/tester_flow.html](/Users/meharaj/WA-copilot/docs/tester_flow.html):159
- [docs/tester_flow.html](/Users/meharaj/WA-copilot/docs/tester_flow.html):177
- [src/renderer/src/BrowserProduct.tsx](/Users/meharaj/WA-copilot/src/renderer/src/BrowserProduct.tsx):1
- [src/renderer/src/tauri-main.tsx](/Users/meharaj/WA-copilot/src/renderer/src/tauri-main.tsx):1

### Finding 5: browser WhatsApp ingress stopped before response handling — resolved

Severity: high

The browser Baileys cursor hydrated an inbound WhatsApp message into the Lead
Directory but did not enter the existing agent generation path. That made
Response Permission appear enabled while no reviewable response could be
produced. Browser text/caption events now dispatch a completion-aware request
through the browser runtime (agentd-backed providers or explicit WebGPU),
persist the generated response as a durable review draft through the existing
authenticated outbox admission route, and advance the
cursor only after that work completes. Direct autonomous delivery and the
Electron response loop remain unavailable in the browser.

Evidence:

- [src/renderer/src/hooks/useWhatsAppBridge.ts](/Users/meharaj/WA-copilot/src/renderer/src/hooks/useWhatsAppBridge.ts):197
- [src/renderer/src/hooks/useAgent.ts](/Users/meharaj/WA-copilot/src/renderer/src/hooks/useAgent.ts):415
- [src/renderer/src/lib/browser-agentd-client.ts](/Users/meharaj/WA-copilot/src/renderer/src/lib/browser-agentd-client.ts):969
- [tests/unit/tauri-ui-boundary.test.ts](/Users/meharaj/WA-copilot/tests/unit/tauri-ui-boundary.test.ts):94

The same retry audit also found that checking only for an assistant chat
message was too early: generation can complete before draft admission or
email policy delivery. Browser retries now use durable event-scoped WhatsApp
drafts and Email draft records as the completion markers, and the WhatsApp
handoff carries the hydrated session id so a participant JID cannot create a
second renderer session.

The post-push Windows workflow `35381574061` was rejected before job startup
because the GitHub account has failed payments or an exhausted spending limit.
No Windows runtime, Credential Manager, packaging, signing, install/upgrade,
or native resource evidence can be claimed from that run.

The next post-push Windows workflow `35383566270` was rejected at the same
pre-job boundary (no job steps or logs were created). It confirms the billing
or spending-limit blocker is still external to the code; it does not provide
Windows runtime, Credential Manager, packaging, signing, install/upgrade, or
native resource evidence.

The documentation follow-up triggered workflow `35383920744` and was rejected
in the same three-second pre-job window, again without executable steps or
logs. The PR therefore still has no hosted Windows runtime evidence.

After merging the migration branch with the updated `main` (including PR #8),
workflow `35500106827` was rejected in the same pre-job boundary. The merge
itself is conflict-free and locally verified; this hosted failure still adds
no Windows runtime evidence.

### Finding 6: browser WebGPU Email could fall through to Electron delivery — resolved

Severity: high

The browser’s explicit WebGPU provider intentionally keeps model generation in
the tab, but the Email response-policy step was still using the legacy
Electron branch. In a normal Edge/Chrome session this could turn an inbound
Email response into an unsupported Electron send attempt instead of a durable
agentd draft/send-policy operation.

The browser policy handler is now shared by agentd-backed and WebGPU
generation. WebGPU responses remain local only until the result is passed to the
same authenticated confidence gate, deterministic event-scoped draft record,
approval state, and bounded delivery route. Electron keeps its existing
`electron.email.send` path, and the browser boundary test asserts that the
WebGPU path uses the agentd handler.

Evidence:

- [src/renderer/src/hooks/useAgent.ts](/Users/meharaj/WA-copilot/src/renderer/src/hooks/useAgent.ts):434
- [src/renderer/src/hooks/useAgent.ts](/Users/meharaj/WA-copilot/src/renderer/src/hooks/useAgent.ts):901
- [tests/unit/tauri-ui-boundary.test.ts](/Users/meharaj/WA-copilot/tests/unit/tauri-ui-boundary.test.ts):115

### Finding 9: browser Email outbound attachments were text-only — resolved

Severity: medium

The browser Drafts panel could review and send only text. It now accepts
explicit operator-selected PDF/image/text files, capped at five files and
10 MiB total. Agentd validates filename, MIME and base64 integrity, scans
supported magic bytes, and emits multipart MIME through secure SMTP or Gmail
API. Electron behavior remains unchanged; inbound attachment bytes never feed
autonomous generation.

Evidence:

- [agentd/email-mime.cjs](/Users/meharaj/WA-copilot/agentd/email-mime.cjs)
- [agentd/server.cjs](/Users/meharaj/WA-copilot/agentd/server.cjs):2398
- [src/renderer/src/components/email/DraftApprovalPanel.tsx](/Users/meharaj/WA-copilot/src/renderer/src/components/email/DraftApprovalPanel.tsx):106
- [tests/unit/agentd-email-transport.test.cjs](/Users/meharaj/WA-copilot/tests/unit/agentd-email-transport.test.cjs):64

### Finding 7: browser Gmail attachment inspection used an empty Electron fallback — resolved

Severity: medium

The browser Autonomy panel already exposed operator-only Gmail attachment
inspection, but its browser adapter returned an empty list/null result and Gmail
normalization discarded attachment metadata. The browser therefore could not
inspect a safe attachment even after Gmail OAuth polling had received it.

Agentd now retains bounded Gmail attachment metadata, exposes authenticated
list/retrieve routes, and performs the retrieval through the fixed Gmail OAuth
API. Returned bytes are released only after the 10 MiB, MIME and magic-byte
checks pass; polling and autonomous generation never download or process the
attachment. Electron keeps its existing attachment service path.

Evidence:

- [agentd/gmail-api.cjs](/Users/meharaj/WA-copilot/agentd/gmail-api.cjs):65
- [agentd/server.cjs](/Users/meharaj/WA-copilot/agentd/server.cjs):2280
- [src/renderer/src/lib/browser-agentd-client.ts](/Users/meharaj/WA-copilot/src/renderer/src/lib/browser-agentd-client.ts):75
- [tests/unit/agentd-email-attachments.test.cjs](/Users/meharaj/WA-copilot/tests/unit/agentd-email-attachments.test.cjs):22

### Finding 8: Tauri had no safe replacement for Electron folder reveal — resolved

Severity: medium

The browser correctly avoided exposing an agentd database path, but the native
companion had no equivalent for an operator who needs to inspect host-owned
diagnostics. Tauri now exposes a no-argument `open_agentd_data_folder` command.
It resolves the data directory from native host state, creates it if needed,
and launches only that fixed path using the platform file manager. The browser
bridge receives no path and cannot supply an arbitrary one.

Evidence:

- [src-tauri/src/main.rs](/Users/meharaj/WA-copilot/src-tauri/src/main.rs)
- [src-tauri/src/agentd_api.rs](/Users/meharaj/WA-copilot/src-tauri/src/agentd_api.rs)
- [src/renderer/src/lib/tauri-native-bridge.ts](/Users/meharaj/WA-copilot/src/renderer/src/lib/tauri-native-bridge.ts)
- [tests/unit/tauri-native-bridge.test.ts](/Users/meharaj/WA-copilot/tests/unit/tauri-native-bridge.test.ts)

## Recommended Source-of-Truth Order

Use this order:

1. [docs/app-behavior.md](/Users/meharaj/WA-copilot/docs/app-behavior.md)
2. Current implementation in renderer/main code
3. Focused progress docs such as [docs/email-channel-progress.md](/Users/meharaj/WA-copilot/docs/email-channel-progress.md), but only after checking them against the behavior contract
4. Older narrative/manual docs such as [docs/tester_install.html](/Users/meharaj/WA-copilot/docs/tester_install.html), which now link back to the behavior contract for any detail not covered by the quick-start flow

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

## Browser workspace QA — 2026-09-21

Runtime: local `agentd` against the built `dist/tauri.html`, opened in the
browser workspace at a loopback URL. The first attempt used a reused daemon
whose six-digit pairing code had expired; restarting an isolated daemon with a
fresh code passed the same flow.

Steps and observed results:

1. Opened the unpaired workspace. The page showed **Pair this browser**, a
   six-digit input, and a disabled **Pair browser** action until input was
   valid.
2. Entered the fresh owner code and paired. The browser mounted the product
   dashboard, showed the local agentd status, and did not emit console errors.
3. Opened the command palette with `Ctrl/Command+K`, selected **Settings**,
   and verified the WhatsApp, Email, MCP, model, Knowledge Base, Web
   Automation, Appearance, Audit Logs, and System Info sections.
4. Confirmed browser-safe copy for Email, MCP, audit storage, memory, and
   native dependency boundaries; no credential value or native path appeared.
5. Navigated to Conversations, toggled the sidebar shortcut, and confirmed the
   chat input, workspace/file picker, voice control, and send gate were visible.
6. Checked the browser console after navigation; no warnings or errors were
   reported.

Result: startup, pairing, authenticated workspace mount, settings navigation,
browser-only capability boundaries, and console cleanliness passed. Live
provider sends, real Windows Credential Manager interaction, real microphone/model
hardware behavior, and real-user profile continuity remain separate release gates.
