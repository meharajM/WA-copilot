# App Behavior

Last updated: 2026-07-10

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
- The expected Windows flow is: start the native companion/service, open the displayed loopback URL in Edge or Chrome, pair once, and keep using the browser tab. Closing the browser or companion does not stop `agentd`.
- Closing the browser or companion does not stop `agentd`; explicit agent controls own processing state.
- Electron remains a transition client until browser plus `agentd` feature/data parity is evidenced.

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
  - optional workspace path
  - optional topic classification
- Agent execution is isolated per session. Switching sessions while one is running must not move output into the wrong session.

Pass evidence:

- Starting work in a new context creates a new session.
- Running work in one session and switching to another does not cross-write messages or progress.

## Command Center

- The dashboard view is the operational home screen.
- It surfaces live-ish metrics derived from session, RAG, memory, and intelligence stats.
- It offers at least:
  - WhatsApp connect or toggle action
  - knowledge upload
  - knowledge test drive
  - topic analysis of sessions
- Knowledge upload accepts documents and images in the legacy Electron flow. In the browser product, the authenticated agentd adapter currently accepts bounded text/Markdown/CSV/JSON/XML/HTML/log files through the browser file picker; binary conversion remains an explicit unsupported state until a native parser capability is migrated.
- Knowledge test drive runs a RAG search and then asks the selected LLM to answer only from retrieved context.

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
- In Electron, offline/native speech is the default path.
- Agent execution writes user messages immediately, then streams assistant/tool progress into the owning session.
- Background memory reflection runs asynchronously after submission.

Pass evidence:

- Text submit creates or updates the correct session.
- Attachments appear in the session and do not break submit.
- Voice transcript populates the input when supported.

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

- Customer non-text WhatsApp media is rejected with a text-only support message.
- During long-running customer handling, a courtesy message is sent after 60 seconds.
- If the generated response indicates escalation, the admin/personal phone is notified.
- Successful customer resolutions are logged to intelligence stats.

Pass evidence:

- Non-text customer media does not enter the normal autonomous handling path.
- Long-running requests send exactly one courtesy notification.
- Escalations notify the admin channel.

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

- Email is a client-side local connector flow.
- The primary path is IMAP/SMTP.
- Gmail is presented as a first-class option, but defaults to app-password mode.
- Google sign-in is optional, not required.

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

- Gmail app-password mode can test and start without requiring OAuth.
- Gmail Google sign-in mode fails cleanly when OAuth is not configured or not signed in.

### Channel gating

- `Enable Email Channel` controls whether the background email bridge starts.
- `Draft Mode` controls whether even high-confidence outbound replies are held as drafts.
- `Auto-Reply` controls whether inbound email messages are submitted into the agent pipeline.
- Current behavior: if `Auto-Reply` is off, inbound emails are ignored by the email bridge and no session is created from inbound mail.

Pass evidence:

- With `Auto-Reply` off, inbound email does not create an email session.
- With `Auto-Reply` on and the channel enabled, inbound email can create a session.

### Safety and reply behavior

- Test connection starts and stops the email channel to verify connectivity.
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
- Drafts can be edited, approved, rejected, or sent.
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
  - open the original file
  - delete indexed knowledge
- Electron ingestion uses the internal RAG tool path. Browser ingestion uses the authenticated agentd knowledge route and stores bounded text content in the daemon-owned SQLite database; the browser never sends an arbitrary native path.

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

- The Business Tools section manages MCP servers except the hidden internal Playwright entry.
- Supported actions include:
  - add
  - edit
  - connect
  - disconnect
  - remove
  - toggle auto-connect
  - troubleshoot
- Troubleshoot injects a prompt into chat for the AI to inspect a tool failure.

Pass evidence:

- MCP server form can create and update entries.
- Connection state changes reflect in the UI.

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
- A reveal/open-folder action is available.
- The UI states logs are local and append-only.

Pass evidence:

- Log path resolves.
- Reveal action opens the folder without crashing.

## About and System Info

- About shows product name, version, status, platform, and engine labels.
- It is informational, not a primary configuration surface.

Pass evidence:

- Version and static metadata render.

## Command Palette

- Command palette opens with `Cmd/Ctrl+K`.
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

- Email inbound automation currently depends on `Auto-Reply` being on. This is stricter than a passive "monitor-only" email mode.
- Lead Directory supports non-WhatsApp sessions in the data model, but some copy still describes it as WhatsApp-only.
- The LLM provider selector includes `browser`, but there is no dedicated browser-provider configuration card in the panel yet.
- Resolution-audit helper text in some logs/comments still references older timing language, but the actual timeout is 10 minutes.

## QA Reporting Format

For every manual test run, capture:

- build and test preflight result
- app build or install path used
- exact feature area tested
- expected behavior from this document
- observed behavior
- pass/fail
- screenshots or logs when behavior fails
- whether the issue is config-only, runtime-only, or product-contract drift
