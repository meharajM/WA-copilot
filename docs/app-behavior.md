# App Behavior

Last updated: 2026-09-18

## Purpose

This document is the source of truth for manual QA and skill-driven verification of the current app behavior in this repository.

Audience:

- testers validating packaged builds and local installs
- developers changing runtime behavior, prompts, policies, or channel controls

Use this document to answer:

- what the app is expected to do,
- which switches or preconditions must be true before a behavior can happen,
- what evidence counts as a pass,
- which current limitations are intentional or at least currently implemented.

If older manuals, screenshots, or marketing copy disagree with the running code, treat this file and the current code as authoritative for QA.

## Runtime boundary

- The supported product workspace is rendered in the user's web browser (Windows Edge or Chrome are the primary targets) and talks to the local authenticated `agentd` service over loopback HTTP.
- The Tauri companion is a lightweight native host for OS-only capabilities such as keychain access, file/folder dialogs, service lifecycle and diagnostics. It must not render a second product workspace or own business workflows.
- In a real Tauri runtime, the only rendered surface is the native-host diagnostics/onboarding screen. Chat, settings, channels, Brain/knowledge, memory, approvals and all other product screens are browser-only; no query parameter can opt a Tauri window into them.
- The runtime entrypoints are intentionally different: Electron's `index.html` mounts the legacy `App.tsx` client, while `tauri.html` mounts `tauri-main.tsx`. In a normal Edge/Chrome tab, `tauri-main.tsx` mounts `BrowserProduct`; inside a Tauri webview it mounts `NativeHostDiagnostics` only.
- In the browser product, native dependency installation/checks are skipped explicitly; host tools are owned by the companion/agentd boundary and the browser must not show an Electron terminal-install gate.
- The expected Windows flow is: start the native companion/service, choose `Open browser workspace` from the native diagnostics/tray, pair once in Edge or Chrome with the six-digit code revealed by the owner action, and keep using the browser tab. The companion also displays the bounded loopback URL for manual copy. The code is one-time, short-lived, never copied into browser storage, and never returned by the product API.
- `agentd` owns the loopback HTTP listener, pairing/session state and durable product database. The native host validates the private runtime descriptor and reuses a live daemon; it starts a packaged child only when no valid daemon is available. Closing the browser or companion does not stop a running `agentd`; explicit agent controls own processing state. Automatic service installation, crash recovery and OS user-service registration are not yet release-complete behaviors.
- When the daemon serves the bundled UI, a request for `/` falls back to the `tauri.html` entry when no `index.html` exists. Direct requests for unsupported or traversal paths fail closed rather than exposing files outside the UI root.
- Electron remains a transition client until browser plus `agentd` feature/data parity is evidenced.

### Native-host-only actions

- The native diagnostics screen may report daemon health/origin/version, reveal the owner pairing code, open the browser workspace, select a file or folder for an explicitly initiated workflow, check credential presence, and stage/rollback the bounded continuity snapshot.
- Native commands return paths or status only to the native host workflow that requested them. Browser product code does not receive arbitrary native filesystem paths, secret values, pairing codes or a generic native command proxy.
- A custom button label for the native file picker is rejected because the Tauri dialog does not support that option; callers must use the platform picker labels.

## Verification Order

1. Startup and dependency gate
2. Navigation and session model
3. Channel flows: WhatsApp, Email
4. Knowledge and memory
5. AI model and tool integrations
6. Background automations
7. Appearance, logs, and system info

## Preflight

Before manual testing:

- `npm run typecheck`
- `npm run test:unit`
- `npm run test:integration`
- `npm run build`

For packaged-app testing, also verify one of:

- `/Applications/AIConsumerAgent.app`
- `dist/mac-arm64/AIConsumerAgent.app`

Repository validation note:

- The repository-wide `npm run typecheck` currently stops at the intentionally ignored legacy Electron import `src/main/ipc/antigravity.ts -> src/main/services/AntigravityAuthService.ts`. That file is secret-bearing local setup and is not recreated as a browser/Tauri shim. Until the legacy service is restored or removed as part of the Electron retirement gate, record the full preflight as **blocked at typecheck**, not as a product pass.
- The browser/Tauri migration checks remain independently runnable: `npm run typecheck:renderer`, `npm run test:unit`, `npm run test:integration`, `npm run test:agentd`, `npm run test:agentd:credentials`, `cargo test --locked --manifest-path src-tauri/Cargo.toml`, and `npm run build:tauri:web`. Report each command separately and include the native Windows CI result when evaluating a Windows release candidate.

## Global Contract

### Launch and dependency gate

- On app launch, missing system dependencies can block normal use with a full-screen dependency modal.
- If no dependencies are missing, the modal dismisses automatically.
- The dependency modal can re-check on window focus.
- The dependency modal allows a local install script or a skip path.

Pass evidence:

- Missing dependencies are listed when present.
- Running the install path or resolving dependencies clears the blocker.

### Main navigation

- Default shell uses a left sidebar plus header.
- Main views are:
  - `Command Center`
  - `All Chats`
  - `Brain View`
  - `Lead Directory`
  - `Email Drafts`
- Settings-style views hide the main sidebar and render the settings control panel instead.

Pass evidence:

- Sidebar navigation changes the main pane without crashing.
- Entering settings replaces the main sidebar with the settings sidebar.

### Session model

- Sessions are created lazily on first use.
- Sessions can be generic or channel-bound.
- Supported session channel metadata includes at least:
  - `whatsapp`
  - `email`
- Sessions track:
  - title
  - messages
  - active/resolved status
  - channel, contact identifier, and optional thread identifier for omnichannel sessions
  - optional workspace path
  - optional topic classification
- Agent execution is isolated per session. Switching sessions while one is running must not move output into the wrong session.

Pass evidence:

- Starting work in a new context creates a new session.
- Running work in one session and switching to another does not cross-write messages or progress.

## Command Center

- The dashboard view is the operational home screen.
- It surfaces live-ish metrics derived from session, RAG, memory, and intelligence stats.
- In the browser product, memory statistics and intelligence statistics/logs are read from authenticated `agentd` endpoints; the dashboard must not depend on Electron IPC. Electron remains the transition-client path only.
- It offers at least:
  - WhatsApp connect or toggle action
  - knowledge upload
  - knowledge test drive
  - topic analysis of sessions
- Conversation Topics stays empty until real sessions are analyzed; the browser must not display seeded percentages as if they were activity.
- A fresh browser workspace reports `0%` autonomy until at least one authenticated accuracy event exists; it must not present an empty dataset as successful automation.
- Knowledge upload accepts documents and images in the legacy Electron flow. In the browser product, the authenticated agentd adapter currently accepts bounded text/Markdown/CSV/JSON/XML/HTML/log files through the browser file picker; binary conversion remains an explicit unsupported state until a native parser capability is migrated.
- Knowledge test drive runs a RAG search and then asks the selected LLM to answer only from retrieved context.
- Assistant corrections use the same runtime-aware knowledge route: browser corrections are persisted by authenticated agentd, while Electron uses its internal RAG tool. The UI only reports success after the route returns success.

Pass evidence:

- Metrics render without fatal errors.
- Uploading knowledge changes indexed-source stats after ingestion succeeds.
- Knowledge test returns either an answer grounded in context or a controlled error/fallback.

## Chat Input and General Agent Flow

- Text input supports normal message submission.
- `Enter` submits.
- `Shift+Enter` keeps a newline.
- File attachments are supported.
- If no workspace is set and a file has a native path, the parent folder becomes the session workspace.
- In the browser, supported text and small image attachments are bounded and persisted through `agentd`; the browser directory picker records a workspace reference without exposing arbitrary native paths to page JavaScript.
- Voice input is supported through the speech hook.
- In Electron, offline/native Vosk speech remains the default path and keeps its
  model-download/setup flow.
- In the browser product (including Windows Edge/Chrome), voice input uses the
  browser Web Speech API when `SpeechRecognition` or
  `webkitSpeechRecognition` is available. Browser speech is browser/provider-
  controlled and may require network access; it does not download or execute
  Vosk models in the browser.
- Browser voice starts only after the user presses the microphone control, so
  microphone permission is not requested at page load. A browser that does not
  expose Web Speech API keeps the microphone control disabled and remains fully
  usable for text input. Permission, missing-device, unsupported-language and
  speech-service errors show actionable text instead of silently retrying.
- The browser path does not open a second `getUserMedia` stream for a level
  meter; the Web Speech API owns microphone capture. Native Vosk visualization
  remains unchanged in Electron.
- Agent execution writes user messages immediately, then streams assistant/tool progress into the owning session.
- In the browser product, assistant text arrives through authenticated `agentd` SSE events. Canceling a generation aborts daemon/provider work, leaves no partial assistant message, and allows retry with the same request id; cancellation is not shown as an error message.
- Background memory reflection runs asynchronously after submission.

Pass evidence:

- Text submit creates or updates the correct session.
- Attachments appear in the session and do not break submit.
- Voice transcript populates the input when supported.
- In browser QA, grant microphone permission only after clicking the mic; verify
  interim text, final text, stop/restart, configured `speechLang`, and fallback
  to text when permission or browser support is unavailable.

## WhatsApp Channel

### Connection flow

- Connection dialog supports:
  - idle
  - connecting
  - QR
  - verify
  - connected
  - manage
  - error
- A successful QR scan transitions to connected/manage state.
- Verification flow can set a target phone number and complete a handshake.
- Disconnect can preserve auth or clear auth.

Pass evidence:

- Dialog step transitions match actual connection state.
- Clearing auth requires re-scan on next connect.
- In browser mode, the QR, connection state, handshake, disconnect and auth-directory lifecycle are owned by authenticated local `agentd`; Tauri remains a native capability host and does not render this dialog.

### Runtime gating

- Incoming WhatsApp messages are ignored if both of these are off:
  - `Response Permission` (`whatsappEnabled`)
  - `Autonomous Bot Mode` (`businessBotMode`)
- Incoming self-messages are ignored.
- On disconnect or connection error, `Response Permission` is automatically turned off.

Pass evidence:

- Inbound messages do not create agent activity when both toggles are off.
- Disconnecting clears active response permission.

### Response behavior

- Electron customer non-text WhatsApp media is rejected with a text-only support message. Browser Baileys consumes only bounded text and media captions; media without captions is ignored and no media bytes are downloaded.
- During long-running customer handling, a courtesy message is sent after 60 seconds.
- If the generated response indicates escalation, the admin/personal phone is notified.
- Successful customer resolutions are logged to intelligence stats.

### Browser-first transport

- Edge/Chrome owns the product workflow. With Baileys selected, the browser calls authenticated local `agentd` routes for QR/session state, handshake, disconnect and text sends; the daemon keeps the multi-file auth directory on the local machine and never returns auth keys to the page. With Cloud transport selected, explicit sends use the authenticated `agentd` Cloud API route; the access token stays in the OS credential store and never reaches the page.
- The agentd WhatsApp worker is lazy: constructing the daemon does not import Baileys or open a WhatsApp socket. Baileys dependencies load only after the operator explicitly starts a Baileys connection, preserving local CPU/network resources for the model and browser workspace.
- Browser sends fail closed when the selected transport or credentials are unavailable. The migrated Baileys path supports explicit text sends and approved text-only draft/outbox delivery; `agentd` records a durable pending/sent/failed outbox entry and suppresses duplicate provider calls for either Baileys or Cloud. Failed attempts can be retried through the authenticated browser route; an operator can quarantine or cancel a failed attempt, and those dispositions block accidental re-send. Pending provider work cannot be cancelled or quarantined and returns an explicit conflict. WhatsApp Web automation, media delivery and autonomous direct-send remain unavailable until their provider-backed daemon adapters and remaining outbox safety gates are migrated.
- The local Baileys worker normalizes bounded text and media captions into durable inbound events using stable provider message IDs. Self-messages and broadcast/system messages are ignored; media bytes are not downloaded into the browser path, so unsupported media remains fail-closed.
- A failed channel send does not discard the local chat submission; the browser records the failure through its normal audit/error path so the operator can retry after fixing configuration.
- Browser autonomy metrics come from authenticated agentd durable state (inbound events, draft/outbox statuses, and completed generations). Unsupported decision-review and recovery metrics remain explicitly zero until their agentd adapters are migrated; the UI must not present fabricated success activity.

Pass evidence:

- Non-text customer media does not enter the normal autonomous handling path.
- Long-running requests send exactly one courtesy notification.
- Escalations notify the admin channel.
- A configured Baileys send reaches the connected local session, or a configured Cloud send reaches Meta through `agentd`, while no credential/auth value appears in browser responses, logs or persisted renderer state.

### Resolution audit

- Active WhatsApp-linked sessions are audited for inactivity.
- The current inactivity threshold is 10 minutes.
- If the last message was from the assistant, the app sends a follow-up asking whether the issue is resolved.
- If the last message was from the user, the app logs long user silence instead of sending another prompt.

Pass evidence:

- No repeated follow-up loop happens every minute after the first follow-up.
- Follow-up appears only after the configured inactivity window.

## Email Channel

### Positioning

- Electron currently runs the legacy client-side local connector flow. In the browser product, non-secret Email configuration, app-password IMAP/SMTP, and bounded Gmail OAuth/API text transport are owned by authenticated `agentd`; rich MIME, attachments, and custom MCP paths remain explicitly unavailable.
- The primary path is IMAP/SMTP.
- Gmail is presented as a first-class option, but defaults to app-password mode.
- Google sign-in is optional, not required.
- Browser Email settings never use renderer `localStorage` and app-password values are write-only through the authenticated daemon credential route; the browser cannot read them back.
- Browser email drafts are persisted as bounded, authenticated `agentd` records. Reloading Edge/Chrome rehydrates the same pending/rejected/approved history; the browser does not use renderer `localStorage` as a second draft authority.
- On the first browser startup after this migration, a legacy `aica-email-drafts-v1` renderer record is validated and handed off to agentd; the legacy key is removed only after every draft is accepted, so malformed or partially migrated data remains recoverable for owner review.
- In browser mode, enabling the Email Channel persists the desired state and starts the daemon IMAP poller only when app-password mode, IMAP TLS, an IMAP host, and the OS credential are present, or starts the Gmail API poller only when Google Sign-In is active. `Auto-Reply` controls whether the browser claims events and creates sessions; it does not control mailbox ingestion. Outbound SMTP/Gmail API delivery is available only through the explicit approved-draft send route and its gates.
- When browser Auto-Reply is enabled, the page reads only queued normalized events and acknowledges each event through an authenticated agentd mutation after its session and message are durably hydrated. Acknowledgement is idempotent; an interrupted tab leaves the event queued for retry after reload. Completed events are not reprocessed by another browser tab.

### Provider and auth behavior

- Gmail preset server values are:
  - `imap.gmail.com:993`
  - `smtp.gmail.com:587`
- Gmail has two explicit auth modes:
  - `App Password`
  - `Google Sign-In`
- Runtime only uses Gmail OAuth when both are true:
  - Gmail auth mode is `Google Sign-In`
  - OAuth status is signed in
- Otherwise Gmail resolves to the local IMAP/SMTP bridge.

Pass evidence:

- Electron Gmail app-password mode can test and start without requiring OAuth. Browser Gmail app-password mode can persist credentials, run the bounded transport probe, start the gated text-only IMAP poller, and deliver explicitly approved text-only drafts through authenticated SMTP.
- Browser Gmail Google Sign-In starts a PKCE loopback flow from the local agentd, opens the provider consent page in a browser tab, stores only the refresh token in the agentd OS credential adapter, and exposes only bounded status. The callback is one-time and short-lived; access/refresh tokens never enter browser state, URLs after callback, logs, or API responses.
- Browser Gmail OAuth mode requires configured `GMAIL_OAUTH_CLIENT_ID` (and the server-managed client secret when the provider requires it) and a signed-in status. It runs bounded Gmail API inbox polling and approved text-only sends; expired/revoked refresh tokens fail closed and require explicit sign-in again.

Browser parity boundary:

- In browser mode, email settings and app-password credentials are stored by authenticated local `agentd`; the renderer never reads password values back.
- `Test Connection` performs a server-side IMAP/SMTP secure-transport probe or Gmail API profile probe and reports only bounded reachability/TLS results. It does not expose credentials or guarantee that the separately gated background mailbox worker is currently healthy.
- Browser Gmail Google Sign-In and its bounded Gmail API worker are agentd-owned. Custom MCP transports remain explicitly unavailable; Electron remains the fallback for rich MIME, attachments, and any legacy connector behavior not yet migrated.
- Browser settings survive reload/restart without exposing the credential value; browser test/start uses the daemon probe/worker gates and never probes Electron IPC.
- Draft edits, approvals, rejection, deletion, and explicit send use authenticated agentd mutations with CSRF protection. Only an approved draft, enabled app-password transport with an OS-stored SMTP credential, or enabled signed-in Gmail OAuth transport can trigger delivery. The daemon sends text/plain only over authenticated TLS/STARTTLS or Gmail API, marks the draft `sent` only after provider success, and marks failed attempts `failed`; custom MCP, multipart/HTML messages, and attachments remain fail-closed.
- Browser continuity status is read-only and authenticated. It reports agentd-owned record counts, the allowlisted Electron-to-agentd store contract, and per-key credential presence (`present`/`available`) without returning secret values. Electron stores remain `pending` until an explicit owner-approved native migration flow validates, backs up, imports, and requires reauthentication; the browser endpoint never reads or imports Electron files. Native staging is hash-checked and retry-safe after a lost response; a tampered or partial snapshot fails closed and must be explicitly rolled back.

### Channel gating

- In Electron, `Enable Email Channel` controls whether the background email bridge starts. In browser mode, it persists the desired state and controls whether the daemon's gated IMAP poller runs; it does not authorize SMTP delivery by itself.
- `Draft Mode` controls whether even high-confidence outbound replies are held as drafts.
- `Auto-Reply` controls whether the browser claims queued inbound email messages and submits them into the agent pipeline. The daemon may still ingest and retain normalized events while this gate is off.
- Current behavior: if `Auto-Reply` is off, inbound emails do not create browser email sessions; enabling it claims queued events after durable session/message hydration.

Pass evidence:

- With `Auto-Reply` off, inbound email does not create an email session.
- With `Auto-Reply` on and the channel enabled, inbound email can create a session.
- Browser `Test Connection` reaches the local agentd endpoint, rejects missing credentials, and never returns the stored app password.
- Browser inbound processing is restart-safe: the daemon IMAP worker or Gmail API worker queues deduplicated events, then the browser atomically claims them as `processing` before mapping them to sessions/messages, and agentd marks them completed only after persistence succeeds; duplicate claims and acknowledgements do not create another chat message. Gmail polling advances a bounded timestamp cursor with overlap and durable provider-event deduplication.
- In browser mode, the Drafts panel allows review/edit/approve/reject and invokes the daemon-owned send route only for approved text-only drafts. It must not call an Electron IPC fallback or append a synthetic send failure to the draft text.

### Safety and reply behavior

- Electron `Test Connection` starts and stops the legacy email channel to verify connectivity. Browser `Test Connection` runs the authenticated agentd secure-transport or Gmail API profile probe; background IMAP/Gmail polling has its own enable/auth gates. Browser draft send performs the separate authenticated SMTP or Gmail API transaction.
- Drafts are the safe default.
- Sensitive topics such as refunds, legal, disputes, fraud, and account-deletion style requests escalate.
- Medium-confidence replies become drafts.
- High-confidence replies may send directly only when `Draft Mode` is off and the policy allows `send`.
- If a direct send fails, the app falls back to creating a draft.

Pass evidence:

- Sensitive-topic emails are not auto-sent.
- Direct-send failure produces a reviewable draft instead of silent loss.

### Low-confidence email handling

- If knowledge-grounded confidence is high, the app may reply automatically when policy and settings allow it.
- If confidence is low and the topic is not sensitive, the customer receives one standard acknowledgement explaining that the team will follow up.
- The generated response is retained as an escalated draft, which is the durable owner review item in the Drafts panel.
- Sensitive topics and do-not-contact style requests are never automatically acknowledged; they remain escalated for human review.
- Failed acknowledgement delivery leaves the escalated draft available and does not silently discard the response.

### Draft panel

- Drafts are split into:
  - pending review
  - escalated
  - recent history
- Drafts can be edited, approved, rejected, or sent. In Edge/Chrome, approval and sending are separate explicit actions; status cannot be changed to `sent` without a successful provider-backed outbox call.
- Sending a draft uses reply headers and normalized `Re:` behavior.

Pass evidence:

- Draft actions update state correctly.
- Sending from the panel marks the draft sent on success.

## Brain View and Knowledge Base

### Brain View

- The Brain view lists indexed knowledge documents.
- Users can:
  - add knowledge
  - search documents by name
  - open the original file in Electron when a native path exists
  - delete indexed knowledge
- Electron ingestion uses the internal RAG tool path. Browser ingestion uses the authenticated agentd knowledge route and stores bounded text content in the daemon-owned SQLite database; the browser never sends an arbitrary native path.
- Browser-indexed `browser://knowledge/...` entries do not expose an original native file path or an open-in-Explorer action. Binary conversion and native-file reveal remain explicit unsupported states until a bounded native capability is migrated.

Pass evidence:

- Added documents appear after ingestion.
- Deleted documents disappear from the list.

### Knowledge Base settings

- Knowledge Base settings expose long-term memory configuration, not just RAG files.
- Supported memory backends are:
  - `sqlite` (recommended default)
  - `server-memory` (compatibility backend)
- The panel shows entity count, relation count, storage size, and average search latency.
- `memento-mcp` is not selectable until its adapter is implemented. Persisted legacy selections fall back to SQLite.
- A memory inspector is available.
- In the browser product, memory stats, bounded graph tool calls, and raw JSON export use authenticated agentd routes. The browser does not expose the daemon's native database path; opening the file location remains a desktop-only capability.

Browser session channel/contact metadata is also persisted by authenticated `agentd` session routes, so Lead Directory entries survive browser reload and daemon restart without renderer-local storage.

Pass evidence:

- Backend change persists.
- Stats refresh works.
- Test write updates memory state when the backend is working.

## Lead Directory

- Lead Directory shows sessions with omnichannel identifiers such as `contact_id` or `whatsapp_jid`.
- The current copy is WhatsApp-heavy, but the table can show other channels like email.
- Clicking a lead activates that session.

Pass evidence:

- WhatsApp and email channel sessions with contact identifiers appear in the directory.
- Clicking a row switches the active session.

## Business Tools and MCP

- In Electron, the Business Tools section manages MCP servers except the hidden internal Playwright entry.
- Electron-supported actions include:
  - add
  - edit
  - connect
  - disconnect
  - remove
  - toggle auto-connect
  - troubleshoot
- Troubleshoot injects a prompt into chat for the AI to inspect a tool failure.
- In the browser product, migrated agentd-owned memory and knowledge tools remain available. Any existing MCP definitions are read-only agentd continuity metadata: the browser never reads or writes renderer `localStorage`/legacy Electron state, does not render add/edit/remove/connect/disconnect/auto-connect controls, and never returns environment values. Arbitrary MCP server connect/list/call execution remains explicitly unavailable until its supervised agentd worker is migrated; the browser must not show success-shaped MCP mocks. Electron retains the existing MCP path during transition.

Pass evidence:

- Electron MCP server form can create and update entries.
- Electron connection state changes reflect in the UI.
- Browser shows an explicit unavailable state and does not expose actionable arbitrary-MCP controls; authenticated memory/knowledge routes remain usable.

## Bot Identity

- Bot Identity changes the persona used in system prompts.
- Editable fields are:
  - agent name
  - company/industry
  - conversational tone
  - custom business rules

Pass evidence:

- Saving identity persists and reloads the updated values.

## AI Model Configuration

- Preferred provider options are:
  - `auto`
  - `ollama`
  - `openai`
  - `gemini`
  - `openrouter`
  - `browser`
- Provider availability is checked from the settings panel.
- API keys are stored through secure storage, not plain text inputs only.
- In Edge/Chrome, the supported local-model path is Ollama through the authenticated loopback `agentd` service. The browser sends only validated model/base-URL settings; `agentd` reads no Ollama secret and performs the local `/api/tags` and OpenAI-compatible chat calls. Browser Ollama URLs are restricted to `http://localhost`, `http://127.0.0.1`, or `http://[::1]`.
- Tauri does not render this product settings card. It exposes only native-host diagnostics and OS capability controls; the browser owns the LLM UI.
- In the browser product, the selector is limited to `auto`, Ollama, OpenAI/Compatible, and OpenRouter until the remaining provider adapters are moved into `agentd`; Electron retains its existing Gemini/on-device options during transition.
- Current UI exposes cards for:
  - Ollama
  - OpenAI / Compatible
  - Gemini
  - OpenRouter
- Current limitation: `browser` exists in the provider selector, but there is no dedicated settings card in this panel yet.

Pass evidence:

- Switching providers updates the visible settings cards as implemented.
- Availability checks run without crashing the panel.

## Browser Automation

- Browser settings control Playwright browser selection and headed/headless behavior.
- Supported browser options are:
  - auto
  - chrome
  - msedge
  - firefox
  - webkit
  - chromium
- The app states that browser profile sessions persist across automation runs.

Pass evidence:

- Browser selection persists.
- Headed toggle persists.

## Appearance

- Appearance supports:
  - `dark`
  - `light`
  - `system`

Pass evidence:

- Theme change persists and updates the app shell.

## Audit Logs

- Audit Logs show the local log path.
- Electron exposes a reveal/open-folder action. Browser mode shows an agentd-managed label and downloads a redacted NDJSON audit export instead of exposing a native database path.
- The UI states logs are local and append-only.
- In the browser product, audit entries are redacted before durable SQLite persistence in `agentd` and can be downloaded as NDJSON; browser UI never receives a native database path.

Pass evidence:

- Log path resolves.
- Reveal action opens the folder without crashing.

## About and System Info

- About shows product name, version, status, platform, and engine labels.
- In the browser product, version, host platform, runtime and engine labels come from the authenticated `agentd` system-info route; Electron retains its native app/platform labels.
- It is informational, not a primary configuration surface.

Pass evidence:

- Version and static metadata render.

## Command Palette

- Command palette opens with `Cmd/Ctrl+K`.
- Shortcut labels use `Ctrl` on Windows/Linux browser sessions and `Cmd` on macOS, while the handler accepts either modifier for cross-platform parity.
- It supports at least:
  - clear chat
  - toggle sidebar
  - MCP connections
  - settings
  - WhatsApp connect
  - WhatsApp enable/disable when connected

Pass evidence:

- Palette opens and closes from keyboard.
- Selecting a command executes the corresponding action.

## Known Current Limitations

### Native settings/persona continuity cutover

- Tauri native owner controls can preview, confirm, apply, inspect status, and roll back the `settings-persona` scope after the existing Electron snapshot is staged.
- The cutover copies only validated `business_profile.json` persona fields and the browser-safe `aica-settings` LLM, Ollama, and product-preference fields into agentd `agent_state`; omitted fields retain current agentd values.
- Confirmation uses a short-lived, single-use native bearer token bound to the preview manifest and runtime. Browser sessions cannot confirm or apply this scope, and credentials, OAuth material, MCP command/env values, and chat history remain excluded.
- A mode-600 atomic backup is created before the SQLite transaction, and its path/hash are persisted while the cutover is still `applying`, before any settings mutation. Generation, inbound polling, outbound send admission, and affected settings writes are fenced during commit; admitted provider work drains and completes consistently before the transaction.
- Cutover state, token consumption, idempotency, and backup references survive agentd restart in SQLite; status never returns token or credential values. A restart after confirmation requires fresh native confirmation, while an interrupted `applying` record becomes `needs-recovery` with a manual-recovery indicator and the migration hold active. Rollback verifies the backup's SHA-256 in constant time and keeps `needs-recovery` plus the migration hold active on tamper or restore failure.
- Source and staged identities are revalidated after backup creation immediately before the transaction. The settings wrapper rejects duplicate JSON keys, unknown/conflicting fields, and secret-looking values; known Electron sync/base-URL metadata is ignored rather than copied.
- Windows reads use the packaged `aica-migration-reader` Rust sidecar. It opens every parent directory and the final file with `FILE_FLAG_OPEN_REPARSE_POINT`, rejects reparse attributes, holds parent handles across final open, and enforces the same bounded regular-file checks. If the sidecar is missing or fails, Node fails closed with a 503; Unix remains on descriptor-level `O_NOFOLLOW`.
- Chat-history migration is now a separate native-owner cutover; credential/keychain migration and Electron removal remain deferred release gates.

### Native credential continuity and reauthentication

- The native owner may request a read-only credential inventory after selecting an Electron user-data folder. The native-only route is `POST /api/v1/continuity/credentials/preview` with the explicit confirmation `INSPECT_ELECTRON_CREDENTIALS`; browser sessions cannot submit source paths or invoke it.
- The inventory reads only the top-level key names from Electron's `aica-secrets.json` and `gmail-oauth.json`. It returns bounded store/key presence, default-vs-user scope, and whether the target agentd credential key is supported. It never returns secret values, encrypted blobs, user identifiers, source paths, file hashes, or raw Electron key names for OAuth session material.
- Electron `safeStorage` ciphertext is intentionally not copied or decrypted. The result is `state: reauthentication-required` and `transferable: false`; each supported key must be entered again through the native owner/browser credential write flow, which stores it through agentd's OS credential adapter. Gmail OAuth session material is reported as requiring reauthentication and is never copied; the owner completes a fresh browser Google Sign-In flow.
- Electron secure stores fail closed when OS encryption is unavailable: stored values are never treated as plaintext, returned as ciphertext, or copied into agentd. A Gmail OAuth refresh failure caused by expiry/revocation changes native OAuth status to `requiresReauthentication: true`; the client must show “sign in again” and keep the account disconnected until a fresh owner sign-in succeeds.
- Source files are bounded, regular-file-only, duplicate-JSON-key rejected, and read through the native no-follow/reparse-safe migration reader. Missing stores return an explicit not-found result; malformed, oversized, replaced, or unsafe files fail closed without touching the Electron source or live agentd state.
- The inventory is metadata-only and non-persistent. It does not mark a credential migrated, delete Electron data, or bypass owner reauthentication. A successful inventory therefore proves only that the owner can see which credentials need re-entry, not credential parity.
- Windows credential continuity remains a release gate until the native no-reparse descriptor guarantee and the packaged Credential Manager runtime test are both evidenced. The target-specific `aica-keyring-helper.exe` is the only agentd credential handoff and uses the OS keyring backend (Windows Credential Manager); the Windows smoke must round-trip a scoped throwaway secret through write/read/exists/delete without printing its bytes. CI resource checks prove the helper is staged, but runtime evidence remains open until that smoke passes. Credential values, OAuth refresh tokens, and decrypted Electron `safeStorage` data must never appear in logs, temporary files, browser responses, or renderer state.

### Native chat-history continuity cutover

- The daemon exposes a separate native-owner-only `chat-history` confirmation/apply/status/rollback scope after the allowlisted Electron `chat_history.v2.db` has been staged. The Tauri native diagnostics screen invokes these typed commands only after the owner selects and reviews the Electron data folder; it never renders the product workspace. Browser sessions cannot submit source paths, confirmation tokens, or mutate this scope. Confirmation tokens are transient, never displayed or persisted by the renderer, and never returned by browser APIs.
- The cutover reads only the staged snapshot, rechecks manifest/file hashes and SQLite integrity/schema, and copies the already-verified bytes into a private, short-lived, non-writable snapshot directory before opening SQLite by pathname. A replacement/reparse of that pathname fails closed before parsing. It also fails closed if the source or staged chat-history file has a `chat_history.v2.db-wal`/`chat_history.v2.db-shm` (or corresponding staged-file) sidecar; only a checkpointed, closed database is accepted. It rejects missing/unknown session/message references, duplicate IDs, invalid roles/metadata, the shared migration secret-key denylist (including `session`) and bounded-size violations, then imports sessions/messages into the existing `agentd` tables in one transaction. Legacy `thought`, `toolCalls`, `actions`, `findings`, `plan`, and session `extra_data` are retained in bounded agentd metadata columns; credentials and derived stores remain excluded.
- Existing IDs are deterministic: byte-for-byte equivalent rows are idempotent, while any conflicting session/message row fails closed before mutation. A consumed token cannot replay. Generation, chat writes, inbound polling, and outbound send admission are held/drained during apply.
- A mode-600 atomic backup records imported rows, prior affected rows, manifest/hash and rollback metadata. Status, token consumption, backup hash/path, source hash, and interrupted-apply recovery state persist in agentd SQLite; restart converts `applying` to `needs-recovery` and keeps the hold active. Rollback verifies backup integrity and removes only unchanged rows imported by this cutover.
- Windows no-reparse smoke against junction/symlink replacement, credential/keychain handoff, Electron retirement, and release smoke remain open gates. The native bridge/UI wiring and packaged migration reader cover this bounded file-read gate; they do not claim full continuity migration or Windows release readiness.

- Browser Email inbound polling is daemon-owned and starts only when `Enable Email Channel` is on and either app-password mode has IMAP TLS, an IMAP host, and an OS-stored `email_imap_password`, or Gmail OAuth mode has a signed-in agentd OAuth session. The IMAP worker uses UID-based durable deduplication; the Gmail worker uses a bounded timestamp overlap plus provider-event IDs. Both normalize bounded text-only events for the browser; Gmail HTML is reduced to text, while attachments and unsupported content fail closed. Auto-Reply controls response policy, not mailbox ingestion. STARTTLS is supported for non-993 IMAP endpoints. Approved text-only drafts can deliver through the separately gated daemon SMTP or Gmail API route.
- Browser knowledge imports are text-only and cannot open the original native file after indexing; Electron retains native parser and file-reveal behavior.
- The browser Autonomy panel does not render Electron-only WhatsApp Web automation, native backup staging, or local-retention controls. Baileys reconnect is daemon-owned and surfaced through bounded connection state; native-only controls remain in the Electron transition client until their agentd adapters are migrated.
- Browser audit logs are downloaded as redacted NDJSON; native log-folder reveal remains Electron-only.
- Lead Directory supports non-WhatsApp sessions in the data model, but some copy still describes it as WhatsApp-only.
- The LLM provider selector includes `browser`, but there is no dedicated browser-provider configuration card in the panel yet.
- Resolution-audit helper text in some logs/comments still references older timing language, but the actual timeout is 10 minutes.

## QA Reporting Format

For every manual test run, capture:

- build and test preflight result
- runtime boundary used (`Edge`/`Chrome` browser workspace, Tauri native diagnostics, or Electron transition client)
- Windows host/packaging evidence when claiming Windows readiness (native-host tests, staged-resource verification, bundle, signing/install smoke, and resource measurements are separate gates). The staged-resource gate checks the target-specific agentd runtime and keyring helper, agentd entrypoint/dependencies including the compiled `better-sqlite3` native binding, and browser `tauri.html` plus JavaScript/CSS assets before bundling; it does not claim signing, installation, upgrade, or Windows Credential Manager runtime evidence.
- app build or install path used
- exact feature area tested
- expected behavior from this document
- observed behavior
- pass/fail
- screenshots or logs when behavior fails
- whether the issue is config-only, runtime-only, or product-contract drift
