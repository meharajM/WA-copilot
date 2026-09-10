# Autonomous support agent

The autonomous supervisor runs in Electron's main process and survives renderer reloads and interrupted restarts. It uses the existing RAG index, business persona, LangGraph workflow, and Gemini configuration (`GOOGLE_API_KEY`). Incoming events, decisions, retries, sends, failures, delivery events, and operator actions are stored under the Electron user-data directory in `autonomy.db`.

Deployment boundary: the current pilot is a single-business, single-owner desktop product running on the customer-owned machine. It is not a hosted or multi-tenant service; public webhook relay, centralized secrets, worker leases, and ownership transfer require a separate hosted deployment design.

Retention and recovery: the default retention period is 90 days (`AICA_RETENTION_DAYS`, bounded to 1–100,000 days). The daily sweep removes old conversation messages, terminal inbound/decision/retry/outbound/delivery records, read notifications, usage records, and operator actions; queued, processing, retrying, pending-draft, and unresolved delivery records are retained. An owner can trigger the sweep, stage a validated backup, and clear the recovery hold only after review. Escalations and failures are durable unread owner notifications; contact routing and SLA remain deployment-specific operator decisions.

Modes:

- Observe only: ingest and audit inbound messages; never send.
- Draft: create an auditable decision for review; never send.
- Auto-reply: send only when the owner enables response permission and the message passes grounding and sensitivity checks.

Safety defaults are observe-only, no configured LLM means escalation, sensitive topics escalate, human messages pause that conversation, opt-outs are enforced at ingress and dispatch, outbound sends are idempotent per inbound message, and retries are limited to three attempts. A Baileys disconnect degrades the supervisor and blocks only Baileys dispatch while preserving queued work; Cloud API, email and Meta queues remain independent, and reconnection does not silently resume Baileys sending. `Pause All` stops new processing without deleting queued or audited data. A clean shutdown stays stopped; an interrupted running instance may auto-resume unless a recovery hold is active.

Supported transport and channel status:

- Baileys is the default WhatsApp transport.
- Baileys Auto-reply is experimental and fail-closed by default because the
  installed libsignal dependency has an unresolved protobuf advisory. Set
  `AICA_BAILEYS_EXPERIMENTAL_APPROVED=true` only after security and licensing
  review; observe and draft modes do not require this approval. Cloud API is
  the recommended production Auto-reply transport.
- WhatsApp Cloud API is opt-in through the transport selector and secure credentials. Signed webhook input, provider IDs, templates, delivery updates, and fail-closed legacy IPC guards are implemented.
- Outside the 24-hour WhatsApp service window, autonomous template dispatch is disabled by default. Enable it only with `AICA_WHATSAPP_OUTSIDE_WINDOW_TEMPLATE` (and optional `AICA_WHATSAPP_OUTSIDE_WINDOW_TEMPLATE_LANGUAGE`, default `en_US`) pointing to an active utility template, plus the normal Auto-reply policy gates.
- WhatsApp Web uses a dedicated persistent Playwright profile, manual QR/session restoration, bounded incoming DOM monitoring, screenshots, and human takeover. Autonomous outbound Web sends remain disabled until live delivery semantics are validated.
- Gmail/email, Instagram, Messenger, and X DM adapters use normalized host queues and channel-specific policy gates. X public posting is not exposed; Meta lead events never imply messaging consent.
- A browser-extension bridge and hosted HTTPS relay are not included in the current desktop build. Official webhooks require an explicitly configured, authenticated reachable relay for production deployment; localhost listeners are for controlled development/pilot use.
- The Memento MCP/Neo4j memory adapter is not shipped. The settings UI does not allow selecting it, and stale persisted selections fail closed to the local SQLite backend until a real adapter is implemented and tested.

Browser and MCP machine control remain separate from customer generation and are not invoked by the supervisor. MCP controls are owner-authenticated, validated, rate-limited, time-bounded, cancellable where supported, and audited; arbitrary shell execution, unrestricted filesystem access, and unrestricted browser evaluation are disabled.
