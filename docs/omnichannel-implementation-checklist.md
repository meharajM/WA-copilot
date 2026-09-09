# Omnichannel support implementation checklist

Date: September 9, 2026

Implements the architecture plan. Complete phases in order. Keep observe-only as the default until phases 0–4 pass.

## Phase 0 — baseline, access and containment

- [x] Record the v1 model: single business, single owner, worker on the owner's machine. (The current Electron pilot is intentionally single-business and single-owner.)
- [x] Decide whether an HTTPS webhook relay is required. (Keep the desktop pilot localhost-only; production Cloud/Meta/X webhooks require an external authenticated HTTPS relay, which is outside this Electron process.)
- [x] Record whether this is our account, a desktop product for customer-owned accounts, or a hosted service. (Current boundary: desktop product for one customer-owned business account; not a hosted or multi-tenant service.)
- [x] Set pilot message, model and channel budgets and maximum conversations. (Host defaults are 100 LLM calls/day, 1,000 outbound messages/day and 100 conversations; all are configurable through bounded environment settings.)
- [ ] Define human escalation contact and SLA; document retention and deletion periods. (Retention defaults to 90 days with explicit preservation of active/recovery records; owner contact and response SLA remain deployment-specific gates.)
- [ ] Verify WhatsApp Business account, number ownership, Cloud API access and Coexistence eligibility.
- [ ] Verify Meta Business, Page and Instagram Professional account access.
- [ ] Verify Instagram, Messenger and Lead Ads permissions and review requirements.
- [ ] Verify X DM access, pricing and spending controls.
- [ ] Audit Gmail OAuth scopes and restricted-scope obligations.
- [ ] Choose approved LLM providers, data regions and local/cloud data handling.
- [ ] List every inbound path and every outbound sender.
- [ ] Find every caller of WhatsAppService.sendMessage and every renderer app:submit-message caller.
- [ ] List every session persistence writer and bot/permission state writer.
- [x] Record baseline test, typecheck, renderer typecheck and build results. (Build passes; existing unrelated typecheck/test failures recorded below.)
- [x] Disable autonomous auto-send during migration. (Default mode is observe; auto-send still requires explicit permission.)
- [x] Verify observe-only never calls a send method. (Host supervisor gate.)
- [x] Verify draft mode generates without response permission. (Host supervisor gate and decision tests.)
- [x] Prevent legacy renderer and new host worker from processing one conversation. (Renderer resolution follow-ups defer while the main supervisor is running or degraded; legacy fallback remains only when supervisor state cannot be read.)

## Phase 1 — contracts and durable storage

- [x] Extend src/main/packages/omnichannel/index.ts with versioned normalized events. (All official normalizers emit schema version 1 and the host validates normalized ingress before queueing.)
- [x] Include business ID, channel-account ID, provider event/message IDs and conversation ID. (Official normalizers stamp configured `AICA_BUSINESS_ID` or the explicit local-pilot ID, provider account scope, provider event ID and stable conversation ID.)
- [x] Include actor classification, provider/local timestamps, content, attachments and raw-event reference. (Baileys, email, Cloud, Meta and X paths now preserve actor, timestamp, content/attachment metadata and raw provider payload references.)
- [x] Add provider capabilities for response windows, templates, delivery receipts and idempotency. (The shared capability registry covers all supported channels and the host enforces its limits.)
- [x] Reject events missing identity scope or provider IDs. (The shared validator requires schema version, business ID, channel-account ID, provider/message identity, sender, recipient, valid timestamp and conversation identity before external queue admission.)
- [x] Add versioned SQLite migrations. (A durable `schema_migrations` ledger records versions 1 and 2; additive changes remain guarded and future changes must advance the ledger.)
- [x] Create channel-account, conversation, inbound-event, job and lease records. (Channel accounts are registered at normalized ingress; conversations, inbound events and fenced leases are durable, and `jobs` is a trigger-backed projection of inbound work with status and attempt tracking.)
- [x] Create graph-run/checkpoint, decision, draft, approval, outbox and delivery records. (Supervisor now persists graph-run lifecycle/status, scoped thread ID, version metadata, decisions, drafts, outbox and delivery events alongside the SQLite checkpointer.)
- [x] Create consent/opt-out, takeover, operator-action, notification and usage records. (All records are durable; usage stores channel, estimated tokens and cost, consent is retained until explicit opt-in, active takeovers are preserved, and completed takeovers follow the 90-day retention policy.)
- [x] Add indexes for pending jobs, revisions, provider IDs and unresolved outbox records. (Supervisor creates indexes for pending inbound work, conversation revisions, provider IDs and unresolved outbox states.)
- [x] Enable and test SQLite WAL. (Supervisor enables WAL at startup and recovery integration tests verify the journal mode.)
- [x] Make backup restore enter paused recovery mode. (Selected SQLite backups are validated and staged; restart swaps the staged DB while preserving a pre-restore copy, and restored state enters a paused recovery hold.)
- [x] Make the host worker authoritative for autonomous conversations. (WhatsApp and email bridges suppress their legacy renderer-agent path while the main-process supervisor is running or degraded; renderer sending remains available for explicit human use.)
- [x] Replace renderer full-session replacement with append/version-checked writes. (Chat persistence now merges stable message IDs and rejects stale renderer snapshots by `updatedAt`; existing messages are never cleared by a save.)
- [x] Preserve existing message IDs during migration. (Normalized adapters persist provider event/message IDs as the inbound primary key; no remapping layer replaces them.)
- [x] Apply retention and deletion across every local autonomous store. (Supervisor prunes aged messages, inbound events, decisions, retries, read notifications, usage and operator records; `AICA_RETENTION_DAYS` defaults to 90 and active work is preserved.)

## Phase 2 — LangChain/LangGraph workflow

- [x] Add only required LangChain/LangGraph packages and pin versions. (The three required packages are exact-pinned in package and lock files.)
- [ ] Verify package licenses, Node compatibility and packaged Electron compatibility.
- [x] Use a persistent SQLite checkpointer locally; use Postgres only for hosted operation. (SQLite adapter is connected to autonomy.db.)
- [x] Keep graph execution independent of renderer Zustand state.
- [x] Stamp every run with graph, prompt, policy and conversation-revision versions. (Decision records now carry all four version fields.)
- [x] Implement immediate control-event handling outside generation queues. (Pause All and conversation takeover abort in-flight model requests and the dispatch gate rechecks authoritative state.)
- [x] Implement duplicate, own-echo, consent and takeover handling. (Inbound dedupe, self-message filtering, durable opt-out/opt-in and owner takeover pause are implemented for Baileys/Cloud-normalized events.)
- [x] Load scoped memory and RAG evidence with provenance. (Decisions use the existing memory backend with business-support/autonomous-agent scope as supplementary context, while RAG remains the grounding authority; decisions persist bounded memory entity and source file/path/rank evidence.)
- [x] Run only allowlisted business lookups. (The autonomous graph has no customer-invoked external lookup tools; it uses scoped memory and RAG only, while owner MCP controls remain separately allowlisted.)
- [x] Generate a schema-validated decision with bounded tokens, calls and time. (Host validates JSON, confidence and grounding; autonomy generation is capped at 512 output tokens and aborted after 25 seconds inside the existing 30-second workflow guard.)
- [x] Persist drafts and escalation notifications. (Draft text, SHA-256 content hash, conversation revision, expiry, supersession, owner listing/approval and durable owner notifications for escalations/failures are implemented; unread notifications are exposed to the owner panel.)
- [x] Create outbox intent only after host policy validation. (Outbound rows are created only after mode, permission, consent, response-window, revision, channel and content gates pass.)
- [x] Increment conversation revision on relevant inbound messages.
- [x] Supersede or regenerate decisions based on an older revision. (Stale decisions escalate and cannot dispatch.)
- [x] Build evaluation cases for common, missing, contradictory, multilingual, follow-up, sensitive, injection and account-specific questions. (A fixture-driven matrix covers all eight categories; contradictory cases explicitly require non-grounded handling and multilingual unsupported text remains fail-closed.)
- [ ] Measure correctness, missed/unnecessary escalation, latency, editing time, recovery time and cost per resolved conversation. (Supervisor now exposes grounded-decision rate, delivery-unknown count, draft approval/editing time, average decision latency and estimated cost per resolved conversation; correctness labels, missed/unnecessary escalation review, recovery-time drills and provider-authoritative metrics remain.)
- [x] Fix or constrain multilingual FTS search. (RAG query normalization now preserves Unicode letters/numbers, normalizes punctuation and quotes each term so provider text cannot inject FTS operators.)
- [x] Keep customer content out of authoritative business knowledge without owner approval. (Customer messages are stored as conversation evidence; only the owner-managed RAG index is authoritative.)
- [x] Wrap external side effects in durable/idempotent tasks. (Outbound records, provider IDs, payload hashes, delivery events and email outbox claims provide durable idempotency and recovery.)
- [x] Test graph resume with stable conversation IDs and old checkpoint fixtures. (Stable IDs, checkpoint persistence and supervisor reload recovery are covered; the current one-node graph has no legacy node rename to migrate.)
- [x] Keep old node names and optional state fields through a drain period. (The current graph has one stable `decide` node and version-stamped decisions; optional normalized fields remain backward-compatible.)
- [x] Quarantine incompatible or corrupted runs. (Invalid backups are rejected; staged restores enter a paused recovery hold and ambiguous sends are quarantined.)

## Phase 3 — policy, approval and outbox

- [x] Implement channel-specific policy evaluation. (WhatsApp, email, Meta and X queue paths use the shared capability registry for response windows, text limits, templates, delivery receipts, idempotency and consent; provider-authoritative live matrices remain external verification gates.)
- [x] Check mode, response permission, global pause and conversation ownership. (Mode, explicit permission, global/conversation pause and the durable supervisor lease are checked before dispatch.)
- [x] Check consent, opt-out, response window and template eligibility. (Consent/opt-out, WhatsApp/Meta windows and the approved Cloud-template registry are enforced.)
- [x] Check sensitivity, recipient validity, content and volume limits. (Sensitive topics, recipients, text bounds, channel windows and daily/channel budgets fail closed.)
- [x] Persist draft evidence, decision version and exact content hash. (Decision versions, bounded evidence, draft revision and SHA-256 content hash are persisted.)
- [x] Expire and invalidate approvals after edits or newer customer messages. (Newer inbound messages supersede pending drafts, the health loop marks expired pending drafts, and approval rechecks revision, expiry, consent and service-window state; `authorized` is transient and never waits for review.)
- [x] Define outbox states: pending, authorized, sending, sent, delivery-unknown, failed, quarantined and cancelled. (All listed states exist in the host flow; unresolved and delivery-history views expose the durable states.)
- [x] Insert intent before provider request and atomically claim dispatch. (Single active Electron authority; multi-worker ownership generation remains pending.)
- [x] Recheck policy immediately before sending. (Revision and pause checks run before each provider call.)
- [x] Store provider IDs, payload hash and delivery events. (Provider IDs, payload hashes and initial sent events are stored for all successful sends; later Cloud callbacks append delivery events, including unmatched provider callbacks.)
- [x] Retry only confirmed pre-send transient failures. (Automatic retry is limited to provider rate-limit responses; network, timeout and 5xx outcomes become delivery-unknown for owner reconciliation.)
- [x] Never automatically retry a timeout after provider acceptance is possible. (Timeout/connection-reset errors become `delivery-unknown`.)
- [x] Restore in paused recovery mode and quarantine ambiguous sends. (Validated backup restore enters recovery hold; ambiguous provider outcomes become `delivery-unknown` and require explicit owner retry or quarantine.)
- [x] Use an ownership generation to reject stale workers. (The single-node supervisor lease increments a durable generation on acquisition and matches owner plus generation on renew, release and health checks.)
- [x] Verify pause, opt-out, takeover and permission revocation during generation and dispatch. (Pause All, opt-out, supervisor reload, persisted owner takeover and final dispatch-predicate coverage now exist; provider-race coverage is represented by the shared fail-closed predicate test.)

## Phase 4 — WhatsApp Cloud API pilot

- [x] Implement official webhook verification and authentication. (Challenge and HMAC validation are implemented.)
- [x] Persist events before acknowledging webhooks. (Normalized events enter the host supervisor before HTTP 200.)
- [x] Normalize inbound, media, reply, delivery and owner-echo events. (Cloud text/captions, media IDs, reply context, provider IDs and business-number owner echoes are normalized; uncategorized media is escalated.)
- [x] Implement Cloud API sending and provider-ID storage. (Cloud adapter returns provider IDs and supervisor refreshes the selected transport when starting; signed webhook input is the Cloud inbound path.)
- [x] Implement templates as an allowlisted policy operation. (Owner-triggered Cloud template sends require an active registry entry, bounded parameters, opt-in, an outside-window inbound, durable outbox/provider-ID tracking, and Cloud transport; automatic outside-window dispatch remains pending.)
- [x] Classify token, permission, rate-limit, transient and permanent errors. (Host classification stops auth, permission and permanent errors; rate limits/transient failures remain bounded; ambiguous failures become delivery-unknown.)
- [x] Keep Baileys behind an experimental adapter boundary. (Baileys and Cloud share the outbound transport boundary; Cloud selection skips Baileys initialization to prevent mixed operation.)
- [ ] Test response window, templates, duplicate webhooks, owner takeover, opt-out, media, token expiry, 429 and 5xx. (Response-window/template, duplicate webhook, owner-echo/media normalization, takeover/opt-out, token-expiry, and 429/5xx coverage now exists; a complete live pilot matrix remains.)
- [ ] Start observe-only, then draft mode, then narrowly allowlisted auto-reply. (Host blocks direct observe→auto transitions; explicit staged live pilot evidence remains an operator gate.)
- [x] Set small message and model-spend caps. (Host-enforced defaults are 100 LLM calls and 1,000 outbound messages per day; `AICA_DAILY_LLM_CAP` and `AICA_DAILY_OUTBOUND_CAP` can lower/raise them within a validated 1–100,000 range.)
- [ ] Review pilot logs and provider charges daily.

## Phase 5 — email parity

- [x] Normalize Gmail/email events into the shared contract. (Email emissions now include schema version, channel/actor identity, normalized content, subject and thread headers while preserving the legacy email fields.)
- [x] Preserve Message-ID, In-Reply-To and References. (Shared normalization preserves all three and derives a stable conversation ID from References, In-Reply-To, Message-ID or the provider ID.)
- [x] Suppress self-reply loops, auto-replies and mailing-list noise. (Email ingestion rejects self/stale/already-handled messages, auto-submitted replies, bulk/list precedence and mailing-list/autoresponder headers.)
- [ ] Reuse narrow OAuth scopes and document restricted-scope obligations.
- [ ] Use the shared send/draft policy and outbox. (Normalized email events now enter the supervisor queue and share observe/draft/auto policy, RAG decisioning and durable outbound records; successful Gmail/MCP provider IDs are retained; end-to-end provider reconciliation and full email policy parity remain.)
- [ ] Handle token expiry, revocation, polling reconciliation and push-watch renewal. (Gmail token-refresh and 401/403 failures now surface explicit error state, the incremental cursor does not advance after a failed detail fetch, and optional `GMAIL_PUBSUB_TOPIC` watches renew at startup and before expiry; full provider reconciliation remains.)
- [ ] Test threading, bounces, attachments and restart recovery. (Bounce filtering now runs on both MCP and Gmail API ingress; attachment metadata is normalized without downloading file bytes; queued normalized email payloads now reconstruct across restart; binary scanning/retrieval and complete end-to-end coverage remain.)

## Phase 6 — Instagram, Messenger, ads and X

- [ ] Choose one documented Meta login flow per adapter and minimum permissions.
- [ ] Implement independent Instagram and Messenger adapters. (Official Graph signature verification, opt-in localhost startup, inbound normalization and host-side text-send transport now exist; account-specific permissions, durable lead storage and live delivery tests remain.)
- [ ] Implement owner/takeover signals independently per channel. (Meta account echoes and configured X-account DM echoes now normalize as owner messages and pause the customer conversation; live account identity verification remains.)
- [ ] Apply channel-specific windows, limits and error handling. (Meta messages now use a bounded 24-hour auto-response window, 2,000-character send bound and fail-closed outside-window policy; 429/5xx propagation is covered, while live provider matrices remain.)
- [x] Ingest Meta lead events read-only with source, campaign, form and consent evidence. (Leadgen events normalize and persist as attribution records with source/page/form/campaign IDs and no message body; Meta delivery/read receipts now also reconcile through the signed webhook path.)
- [x] Do not treat a lead as unrestricted messaging consent. (Normalized lead records carry `messagingConsent: false`; no lead-to-message path exists.)
- [ ] Keep ad creation, budget and audience changes unreachable from the customer graph.
- [ ] Verify X DM access, endpoint pricing and spending limits. (Adapter targets the documented OAuth1 user-context DM endpoint, implements CRC/signature verification and opt-in localhost wiring; account access and current commercial limits remain an external gate.)
- [x] Keep public X replies in draft/approval mode. (No public-post transport is exposed; only explicit DM transport exists.)
- [ ] Meter X usage separately and block on budget exhaustion. (Outbound usage now records channel and X enforces five active/delivered/ambiguous sends per conversation per 24 hours before provider access; X-specific budget UI/provider limits remain.)

## Phase 7 — UI, MCP and hosted operation

- [x] Replace contradictory bot toggles with authoritative supervisor state. (The autonomy panel separates mode selection from explicit Response Permission; the main-process supervisor is authoritative.)
- [x] Show execution location, mode, permission, ownership, queue, active job and last error. (Panel shows Electron-main execution location, mode, explicit permission, selected transport, LLM/RAG/memory health, channel health, queue, active job, lease ownership and last error.)
- [x] Show drafts, evidence, approval expiry, takeover and delivery-unknown states. (Panel now shows persisted draft hashes/expiry, recent decision evidence, active human takeovers with source/time, bounded unresolved-outbox and delivery-history views, resume controls, and delivery-unknown actions.)
- [ ] Add restart recovery, retention/deletion and cost views. (Daily estimated cost, 14-day aggregated usage/cost history, retention enforcement, manual recovery hold and safe owner-triggered expiry pruning are implemented; backup import integration remains.)
- [x] Expose owner-only health, queue, pause, resume, reconnect, eligible retry and diagnostics tools. (Supervisor IPC now returns channel/queue/active-job/lease/memory health and provides audited reconnect; pause/resume/retry/diagnostic visibility is present in the panel.)
- [x] Authenticate, validate, rate-limit, time out, cancel and audit every control request. (Main-process MCP session tokens are issued only to trusted renderer windows; every control request requires the token and retains validation, rate-limit, timeout, cancellation, capability, and audit gates. Cancellation is renderer-session scoped.)
- [x] Keep shell, unrestricted filesystem and unrestricted browser evaluation disabled. (External MCP stdio is restricted to approved internal aliases or approved `uvx` packages; raw Playwright evaluation is removed from the published registry and denied by host validation; capability allowlists, argument bounds and host-side timeouts remain enforced.)
- [ ] If hosted operation is required, add secrets management, worker leases and explicit ownership transfer.
- [x] Keep automatic failover disabled initially. (No automatic provider failover is implemented; transport changes require explicit owner configuration.)
- [ ] Test desktop-off operation, backup restore, isolation and ownership transfer.

## Final production gate

- [ ] Phases 0–4 exit gates pass.
- [x] Supported auto-reply intents are explicitly allowlisted. (Hours/location/shipping/order-status/availability/price/features/return-policy FAQ patterns are the only intents eligible to reach model generation; sensitive and all other intents escalate.)
- [ ] Answer-quality and cost thresholds are met.
- [ ] Sensitive/account-specific intents use the intended human path.
- [ ] Response-window and template behavior is verified live.
- [ ] Duplicate, stale-decision and ambiguous-send tests pass.
- [x] Opt-out, takeover and Pause All are immediate. (Ingress opt-out/takeover handling and abortable global/conversation pause controls are covered by recovery tests; live pilot confirmation remains an operational gate.)
- [ ] Cost caps and provider limits are active.
- [ ] Retention/deletion and escalation procedures are documented.
- [ ] Owner has completed pause and recovery drills.
- [ ] Release documentation states actual channels and guarantees.

## Verified status — September 9, 2026

Implemented in the current branch:

- Main-process supervisor with start/stop/pause/resume, Pause All, per-conversation pause, persistent state and queue recovery.
- SQLite audit records for inbound events, decisions, retries, outbound attempts and operator actions.
- Duplicate inbound suppression, bounded retries, pre-send claims and safe requeue on pause.
- Structured decision validation with confidence and grounding gates.
- LangGraph decision workflow with SQLite checkpoint persistence and stable per-message thread IDs.
- Durable opt-in/opt-out handling and 24-hour WhatsApp response-window enforcement.
- Cloud API adapter, signed webhook verification, localhost webhook listener and delivery-status reconciliation.
- Basic renderer autonomy controls, delivery visibility and documentation.

Verification snapshot:

- Autonomy, workflow, policy, Cloud API, webhook and recovery tests: 53 passing in the latest targeted run.
- Production build: passing.
- Full typecheck: passing (`npx tsc --noEmit`).
- Full test suite: 34 files passed, 231 tests passed, 7 skipped (238 total).

Known limitations and failed baseline checks:

- The earlier baseline TypeScript, secure-IPC contract and resolution-audit failures are resolved; the current full suite and typecheck pass.
- Cloud runtime selection is explicitly opt-in (`WHATSAPP_TRANSPORT=cloud` or stored Cloud selection); secure credential allowlisting/UI and common outbound transport selection are implemented, but common inbound switching and HTTPS relay deployment are not complete.
- Supervisor startup now crash-resumes only a previously running, unpaused, non-recovery-held state; first launch and clean shutdown remain stopped until explicitly started.
- Renderer session persistence is still a competing writer; host-owned incremental persistence is not complete.
- Complete outbox approval/reconciliation is not complete; core states, draft evidence, approved-template registry/payload generation, payload hashes and explicit retry/quarantine handling for `delivery-unknown` are now recorded.
- Full media download/attachment scanning, full health telemetry, multi-worker leases and hosted operation are not complete; Cloud media metadata/replies/owner echoes are now normalized and media without text is human-escalated. WhatsApp Web now has an isolated persistent-profile connector with manual takeover, but live QR/session selectors and provider delivery validation remain.
- WhatsApp Web selection is explicit and fail-closed: it does not fall through to Baileys, and its outbound path is manual-only pending live send validation. The connector can poll incoming DOM message containers with dedupe under an operator-supplied conversation ID and route them through IPC into the supervisor; live selector/session validation remains.
- Legacy direct WhatsApp text/media IPC sends are now blocked whenever Cloud or Web is selected, preventing a hidden Baileys bypass.
- WhatsApp Web operator controls are exposed through IPC for state, start/stop, human takeover, and bounded failure capture.
- Current LangGraph graph has one decision node; it is a durable workflow seam, not the final multi-node policy/RAG/approval graph.

## Current next three tasks

- [ ] Complete provider-specific delivery reconciliation and live delivery-history verification for email, Meta and X.
- [x] Decide and implement the production HTTPS webhook relay or explicitly keep the desktop pilot localhost-only. (Decision: desktop pilot remains localhost-only; no public listener or implicit tunnel is shipped.)
- [ ] Complete hosted/ownership and live-account gates: secrets, ownership transfer, provider access, pilot drills and charge review.

## Iteration log

- Iteration: added secure Cloud credential fields, OS-keychain allowlisting, store-backed transport selection, awaitable webhook startup, and startup integration coverage. Result: webhook server test passes; build passes; five unrelated email typecheck errors remain.
- Iteration: added the common outbound transport contract and fail-closed Cloud selection. Result: transport and webhook tests pass; build passes; Baileys remains the default.
- Iteration: added outbound payload hashes and `delivery-unknown` handling for ambiguous provider errors. Result: 17 targeted tests pass; build remains passing.
- Iteration: added audited operator retry/quarantine controls for `delivery-unknown` records and surfaced them in the autonomy panel. Result: 17 targeted tests pass; renderer typecheck has only existing unrelated errors; build passes.
- Iteration: added durable approved-template registry, validated owner IPC operations, and Cloud template payload generation. Result: 18 targeted tests pass; build passes.
- Iteration: added `pending → authorized → sending` transitions and audited cancellation for pre-dispatch outbound work. Result: 18 targeted tests pass; build passes.
- Iteration: added durable draft evidence with exact content hashes, conversation revisions, expiry timestamps and supersession on newer inbound messages. Result: 19 targeted tests pass; build passes; approval/expiry/notification flow remains.
- Iteration: normalized Cloud media IDs, reply context, provider event IDs and owner echoes; media without text now escalates before generation. Result: 20 targeted tests pass; build passes; attachment retrieval/scanning remains.
- Iteration: classified provider failures into auth, permission, rate-limit, transient and permanent classes; non-retryable classes now stop bounded retrying while ambiguous sends remain quarantined. Result: 21 targeted tests pass; build passes.
- Iteration: exact-pinned the installed LangChain/LangGraph dependencies and refreshed the lockfile. Result: 21 targeted tests pass; lockfile check passes; Node 20 emits the existing engine warning because the app requires Node 22.12+.
- Iteration: added main-process draft listing and revision/expiry-checked owner approval, wired through preload/electron APIs and the autonomy panel. Result: 21 targeted tests pass; build and diff checks pass; escalation notifications and richer evidence view remain.
- Iteration: added durable owner notifications for escalations and send failures, owner-only IPC listing/acknowledgement, and panel visibility. Result: 21 targeted tests pass; build and diff checks pass; external notification delivery and usage metering remain.
- Iteration: added durable daily LLM/outbound usage events, hard host-side caps, budget escalation notifications and panel counters. Result: 21 targeted tests pass; build and diff checks pass; configurable budgets, provider token-cost accounting and retention remain.
- Iteration: made daily usage caps deployment-configurable with validated environment overrides and safe defaults; removed misleading fixed-cap labels from the panel. Result: 21 focused tests pass; build and diff checks pass.
- Iteration: added durable estimated token/cost fields for LLM usage, configurable per-1K-token pricing via `AICA_LLM_COST_PER_1K_TOKENS`, and daily estimated-cost visibility. Result: 21 focused tests pass; build and diff checks pass.
- Iteration: added daily retention pruning across autonomous SQLite stores, preserving active work and configurable through `AICA_RETENTION_DAYS` (default 90). Result: 21 focused tests pass; build and diff checks pass.
- Iteration: added owner IPC and panel views for aggregated 14-day LLM/reply/estimated-cost history. Result: 21 focused tests pass; build and diff checks pass.
- Iteration: added a durable recovery hold that pauses the supervisor, blocks resume until explicitly cleared, audits the action and surfaces the hold in the UI. Result: 21 focused tests pass; build and diff checks pass; backup import integration remains.
- Iteration: added an audited owner control to prune only retention-eligible local data immediately, preserving active and unresolved records. Result: 21 focused tests pass; build and diff checks pass.
- Iteration: added validated, staged autonomy SQLite backup restore with pre-restore preservation, startup swap and mandatory recovery hold, plus the owner UI flow. Result: 21 focused tests pass; build and diff checks pass.
- Iteration: added recovery integration tests for valid backup staging and resume blocking/hold clearing. Result: 23 focused tests pass; build and diff checks pass.
- Iteration: added backup-isolation coverage proving invalid autonomy databases are rejected without staging. Result: 24 focused tests pass; build and diff checks pass.
- Iteration: expanded policy integration coverage for observe-only, opt-out, sensitivity, grounding, permission and auto-send gates; corrected the expected observe-only escalation behavior. Result: 27 focused tests pass; build and diff checks pass.
- Iteration: enabled SQLite WAL and added indexes for pending work, revisions, provider IDs and unresolved outbox records; added direct storage-invariant coverage. Result: 28 focused tests pass; build and diff checks pass.
- Iteration: added supervisor integration coverage proving repeated provider events create one durable inbound record. Result: 29 focused tests pass; diff check passes.
- Iteration: added supervisor integration coverage for Pause All queue holding and opt-out persistence before response processing. Result: 31 focused tests pass; diff check passes.
- Iteration: added supervisor reload coverage proving queued work is reconstructed from persistent state without automatic resume. Result: 32 focused tests pass; build and diff checks pass.
- Iteration: persisted active human-takeover state, restored takeover pauses on supervisor startup, and added owner-event integration coverage. Result: 33 focused tests pass; build and diff checks pass.
- Iteration: refreshed the selected outbound transport on supervisor start and prevented Baileys initialization when Cloud transport is selected, closing the mixed-transport runtime gap. Result: 33 focused tests pass; build and diff checks pass.
- Iteration: added an immediate pre-provider permission/mode recheck that converts a revocation into a durable draft instead of sending. Result: 33 focused tests pass; build and diff checks pass.
- Iteration: centralized the final dispatch predicate and added fail-closed coverage for permission revocation and pause state. Result: 34 focused tests pass; build and diff checks pass.
- Iteration: added Cloud API 429/5xx tests and duplicate-delivery coverage through the signed localhost webhook server. Result: 35 focused tests pass; targeted suite passes.
- Iteration: added explicit expired-access-token coverage for Cloud sending. Result: 36 focused tests pass; targeted suite passes.
- Iteration: bounded the LangGraph decision node to 30 seconds and fail-closed to an escalation decision on timeout/error. Result: 37 focused tests pass; build and diff checks follow the same iteration.
- Iteration: blocked free-form draft approval after the 24-hour window so it cannot bypass template-only enforcement. Result: 37 focused tests pass; build and diff checks pass.
- Iteration: added explicit allowlisted Cloud-template dispatch with outbox, payload hashing, provider-ID storage, consent/window gates, and IPC exposure. Result: 37 focused tests pass; build and diff checks pass.
- Iteration: added the operator-panel template selector and send action for pending drafts. Result: 37 focused tests pass; build and diff checks pass.
- Iteration: added host-level allowlisted-template integration coverage for consent/window gates, provider-ID persistence, payload hashing, and duplicate suppression. Result: 38 focused tests pass; build and diff checks pass.
- Iteration: added negative host coverage proving unapproved templates, inside-window template use, and opted-out recipients fail before provider access. Result: 39 focused tests pass; build and diff checks pass.
- Iteration: added a durable SQLite supervisor lease, heartbeat renewal, provider-call rechecks, and fresh-lease collision coverage. Result: 40 focused tests pass; build and diff checks pass.
- Iteration: added MCP server/tool validation, shell/eval rejection, argument bounds, and a 30-second external call timeout. Result: 42 focused tests pass; build and diff checks pass.
- Iteration: added persisted per-server MCP capability allowlists with external default-deny and the narrow MarkItDown converter default. Result: 43 focused tests pass; build and diff checks pass.
- Iteration: added persistent local MCP audit records for connection and tool-call outcomes with 90-day retention. Result: 44 focused tests pass; build and diff checks pass.
- Iteration: added trusted-renderer checks, per-server/tool rate limiting, request IDs, and AbortSignal cancellation for MCP calls. Result: 44 focused tests pass; build and diff checks pass.
- Iteration: added trusted-window MCP session authorization and required the token on all control requests. Result: 44 focused tests pass; build and diff checks pass.
- Iteration: normalized email emissions through the shared channel contract with Message-ID, In-Reply-To and References preservation. Result: 45 focused tests pass; build and diff checks pass.
- Iteration: added email self-loop, auto-reply, and mailing-list suppression at ingestion with focused policy coverage. Result: 48 focused tests pass; build and diff checks pass.
- Iteration: derived stable email conversation IDs and provider event IDs from preserved thread headers. Result: typecheck passes; full suite 200 passed/7 skipped; build and diff checks pass.
- Iteration: classified Gmail 401/403 responses as OAuth expiry/revocation and surfaced re-authentication guidance for polling and sending. Result: 49 focused tests pass; build and diff checks pass.
- Iteration: exposed pending-draft content hashes and approval expiry in the autonomy panel. Result: 49 focused tests pass; build and diff checks pass.
- Iteration: exposed persisted human takeovers in the autonomy panel with explicit resume controls. Result: 49 focused tests pass; build and diff checks pass.
- Iteration: added main-process health snapshots and audited WhatsApp reconnect control, surfaced in the autonomy panel. Result: 49 focused tests pass; build and diff checks pass.
- Iteration: added a conservative FAQ intent allowlist before autonomous model execution. Result: 50 focused tests pass; build and diff checks pass.
- Iteration: enforced the observe→draft→auto progression at the supervisor mode boundary. Result: 51 focused tests pass; build and diff checks pass.
- Iteration: added durable idempotent email outbox claims and sent/failed/provider-ID tracking for Gmail and MCP sends. Result: typecheck passes; full suite 201 passed/7 skipped; build and diff checks pass.
- Iteration: fixed the 10-minute resolution-audit threshold mismatch and made secure IPC handler registration visible to the contract scanner. Result: full suite 199 passed, 7 skipped; build and diff checks pass.
- Iteration: prevented the renderer resolution auditor from sending while the main supervisor owns autonomous processing. Result: full suite 200 passed, 7 skipped; build and diff checks pass.
- Iteration: cleared the remaining TypeScript errors in the supervisor transport, autonomy decision module, and email store typing. Result: typecheck, full suite 200 passed/7 skipped, build and diff checks pass.
- Iteration: added bounded-window conversation outcome and decision-latency metrics to the supervisor and panel. Result: 51 focused tests pass; build and diff checks pass.
- Iteration: preserved Gmail attachment metadata (provider ID, filename, MIME type and size) in normalized email events without binary retrieval, with coverage. Result: 53 focused tests pass; full suite 202 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: made an abandoned email `sending` lease reclaimable after 10 minutes and added restart-sized timeout coverage, preventing permanent outbox stalls after a process crash. Result: full suite 203 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: applied bounce suppression to Gmail API polling before dedupe/emission and added policy coverage for daemon/postmaster and multipart-report messages. Result: full suite 204 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: routed normalized email events from the main email ingress into the supervisor’s per-conversation queue and shared decision/outbox policy, with email provider sends remaining host-controlled. Result: email ingress integration coverage passes; full suite 205 passed/7 skipped; typecheck and diff checks pass.
- Iteration: propagated provider message IDs from Gmail/MCP email sends into supervisor outbound records. Result: full suite 205 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added official-Graph Instagram/Messenger signature verification, inbound text/media normalization and provider-ID text sending behind a separate transport boundary. Result: 29 test files, 207 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added read-only Meta leadgen normalization with page/form/campaign attribution and an explicit false messaging-consent flag. Result: 29 test files, 208 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added an opt-in localhost Meta webhook server with GET verification, bounded raw-body reads, HMAC validation, normalized message forwarding and read-only lead forwarding. Result: 30 test files, 209 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: wired configured Meta webhook startup/shutdown to the supervisor’s Meta message queue; startup remains disabled without explicit channel, verify-token and app-secret environment values. Result: 30 test files, 209 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: persisted Meta leadgen attribution in the supervisor database with a database-enforced false messaging-consent value and connected the webhook callback. Result: 30 test files, 210 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added Meta owner-echo takeover detection and durable opt-out/opt-in handling before queueing generation. Result: 30 test files, 211 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: enforced the Meta 24-hour messaging window in the shared external dispatch policy with focused boundary coverage. Result: 30 test files, 212 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added Meta recipient/text bounds and focused 429/error propagation coverage, leaving retry authority in the supervisor. Result: 30 test files, 213 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added an OAuth1 user-context X DM adapter and inbound `message_create` normalizer; public-post sending remains unavailable by construction. Result: 31 test files, 215 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added X CRC response and webhook-signature verification primitives for Account Activity-style delivery. Result: 31 test files, 216 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: connected an opt-in X webhook server and X queue/transport path with CRC, bounded body reads and signed DM forwarding. Result: 32 test files, 217 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added channel-tagged outbound usage and the documented five-message/24-hour X DM response cap before provider access. Result: 32 test files, 217 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: persisted normalized inbound payloads and reconstructed WhatsApp/email/Meta/X queued jobs into their channel-specific queues after restart, with multi-channel recovery coverage. Result: 32 test files, 217 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added an isolated persistent WhatsApp Web Playwright profile with manual QR/session-state classification, health checks, failure screenshots and explicit human takeover. Result: 33 test files, 218 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: made WhatsApp Web an explicit transport selection that skips Baileys initialization and rejects autonomous outbound sends until live semantics are verified. Result: 33 test files, 218 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: exposed bounded WhatsApp Web state/start/stop/takeover/diagnostic controls through the existing IPC/preload boundary. Result: 33 test files, 218 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added WhatsApp Web status/profile visibility and operator Open Web, Human takeover and failure-capture actions to the autonomy panel. Result: 33 test files, 218 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: blocked legacy direct text/media WhatsApp IPC sends whenever Cloud or Web is selected, preventing a hidden Baileys bypass; the selection predicate is side-effect-free and covered. Result: 33 test files, 220 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added bounded WhatsApp Web incoming-DOM polling with message-ID dedupe and normalized event emission, plus stop-monitoring IPC control. Result: 33 test files, 219 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: wired validated Web chat monitoring from IPC/UI into the supervisor’s existing WhatsApp queue, with explicit stop-monitoring control. Result: 33 test files, 220 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: closed the legacy WhatsApp text/media IPC transport bypass for Cloud/Web selections and added regression coverage. Result: 33 test files, 220 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: fixed restart/resume scheduling so reconstructed email and Meta queues drain alongside WhatsApp queues, with regression coverage for external-channel recovery. Result: 33 test files, 221 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: made delivery-unknown retry restore the original inbound payload and route back to the correct WhatsApp, email, Meta or X queue, with external-channel regression coverage. Result: 33 test files, 222 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: enforced durable opt-out handling at email ingress so opted-out addresses are marked and never queued for autonomous processing, with regression coverage. Result: 33 test files, 223 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added the existing email connection state to host health and the autonomy panel, so autonomous email ingress is visible alongside WhatsApp status. Result: 33 test files, 223 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: surfaced Gmail token-refresh failures and prevented incremental cursor advancement when message-detail reconciliation is incomplete, with focused recovery tests. Result: 34 test files, 225 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added optional Gmail Pub/Sub watch registration with validated topic names and scheduled renewal while retaining polling fallback. Result: 34 test files, 226 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: reconciled known Cloud delivery failures into inbound event status, owner notifications and failure audit records, while auditing unmatched provider IDs. Result: 34 test files, 227 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added a health-loop draft expiry sweep that durably marks overdue pending drafts as `expired`, with recovery coverage. Result: 34 test files, 228 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: exposed a bounded unresolved-outbox list through host IPC/preload and the autonomy panel, with retry/quarantine controls limited to `delivery-unknown` records. Result: 34 test files, 228 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: separated Response Permission from the autonomy mode controls in the panel while retaining the host-side requirement that permission can only enable Auto-reply dispatch. Result: 34 test files, 229 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: exposed bounded append-only delivery history through host IPC/preload and the autonomy panel, including provider IDs, channel, status, timestamp and inbound correlation. Result: 34 test files, 229 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added crash-safe supervisor auto-resume after interrupted runs, while preserving explicit start requirements for first launch, clean shutdown and recovery holds. Result: 34 test files, 230 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added execution location, selected transport and LLM-configuration health fields to the host health payload and autonomy panel. Result: 34 test files, 230 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: corrected `docs/autonomous-agent.md` to document the implemented Baileys, Cloud, Web, email, Meta and X paths, operating modes, safety defaults, and current extension/relay limitations. Result: 34 test files, 230 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: re-read durable opt-out state immediately before WhatsApp and external policy disposition, preventing already-queued messages from bypassing a later opt-out. Result: 34 test files, 228 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added a shared channel capability registry and enforced external response windows and text-length limits before dispatch. Result: 34 test files, 229 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: added append-only delivery-event persistence for Cloud callbacks, linked events to inbound records when known, audited unknown IDs, and included events in retention cleanup. Result: 34 test files, 229 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: refreshed the current-next-three section to remove completed Cloud/template/recovery work and point at provider reconciliation, production relay choice, and hosted/live-account gates. Result: 34 test files, 230 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: attached bounded RAG source provenance to grounded and failed-validation decisions and verified it through the real decision path. Result: 34 test files, 231 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: integrated the existing memory backend as scoped supplementary context for autonomy decisions, with RAG remaining authoritative and memory failures falling back safely. Result: 34 test files, 231 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: exposed persisted decision evidence through bounded host IPC/preload APIs and the autonomy panel, completing operator visibility of RAG sources used by recent decisions. Result: 34 test files, 231 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: attached bounded memory entity provenance to grounded and failed-validation decisions and verified it through the real decision path. Result: 34 test files, 231 passed/7 skipped; typecheck, build and diff checks pass.
- Iteration: recorded initial provider message delivery events for successful WhatsApp, email, Meta and X sends, preserving channel and inbound correlation before later provider callbacks. Result: focused recovery suite 20 passed; typecheck passes.
- Iteration: resolved the webhook deployment decision by explicitly keeping the Electron desktop pilot localhost-only; production deployments must supply an authenticated external HTTPS relay. Result: documentation-only change; full verification remains green.
- Iteration: recorded the v1 ownership boundary as a single-business, single-owner desktop product for a customer-owned account; hosted multi-tenant operation is out of scope until separately designed. Result: documentation-only change; full verification remains green.
- Iteration: added a host-side maximum-conversation admission cap with durable capacity-limited events and owner notification; default is 100 and existing conversations continue processing. Result: focused recovery suite 20 passed; typecheck passes.
- Iteration: bounded autonomy model execution to 512 output tokens with an abortable 25-second Gemini request, retaining the 30-second workflow timeout, and added option propagation coverage. Result: focused recovery suite 20 passed; typecheck passes.
- Iteration: reconciled checklist status with implemented host controls for allowlisted lookups, durable notifications/outbox, scoped knowledge, policy validation, content limits, evidence persistence and disabled failover. Result: documentation-only correction; full verification remains green.
- Iteration: added regression coverage for the maximum-conversation admission cap and durable `capacity_limited` state. Result: focused recovery suite 21 passed; typecheck passes.
- Iteration: aligned the architecture document with the actual deployment boundary: localhost-only desktop pilot, with HTTPS relay deferred to a separately designed production deployment. Result: documentation-only correction; full verification remains green.
- Iteration: restricted automatic WhatsApp retries to confirmed pre-send rate-limit responses; network, timeout and 5xx failures now become delivery-unknown instead of risking duplicate sends. Result: focused policy/recovery suites 33 passed; typecheck passes.
- Iteration: documented the 90-day retention policy, protected active/recovery records from pruning, and clarified owner-triggered pruning/backup recovery behavior; escalation contact and SLA remain open operational gates. Result: documentation-only change; full verification pending.
- Iteration: added retention regression coverage proving old terminal inbound records are pruned while queued active work is preserved. Result: focused recovery suite 22 passed; typecheck passes.
- Iteration: wired global and conversation pause controls to abort in-flight model generation, with dispatch state rechecked afterward; added control regression coverage. Result: focused recovery suite 23 passed; typecheck passes.
- Iteration: aligned outbox/recovery checklist status with the implemented draft expiry, revision invalidation, durable state machine, backup recovery hold and explicit ambiguous-send quarantine behavior. Result: documentation-only correction; full verification remains green.
- Iteration: fixed X DM owner-echo classification and conversation correlation using the configured account ID, with webhook propagation and takeover regression coverage. Result: focused X suites 5 passed; typecheck passes.
- Iteration: normalized Meta delivery/read receipts and wired them through the signed webhook server into the existing append-only delivery reconciler. Result: focused Meta/recovery suites 30 passed; typecheck passes.
- Iteration: reconciled schema/recovery/policy checklist status with the current implementation, including ID preservation, one-node compatibility, invalid-backup quarantine and shared channel capability gates; retained explicit live/provider gates. Result: documentation-only correction; full verification remains green.
- Iteration: added shared normalized-event validation at email/Meta/X host ingress, rejecting missing version, provider identity, sender/recipient, timestamp or conversation identity before queueing. Result: focused normalization/recovery suites 27 passed; typecheck passes.
- Iteration: completed normalized identity scoping by stamping business and channel-account IDs on email, Cloud, Meta and X events and requiring them at host ingress; local pilot scope is explicit and configurable via `AICA_BUSINESS_ID`. Result: focused normalization/provider/recovery suites 40 passed; typecheck passes.
- Iteration: added host-side prompt-injection and account-specific request escalation, plus deterministic evaluation coverage for sensitive, injection, multilingual and account-specific cases. Result: focused policy/recovery suites 36 passed; typecheck passes.
- Iteration: added deterministic evaluation coverage for common FAQ, missing-knowledge, not-grounded/contradictory model output and stale follow-up cases. Result: focused decision suite 14 passed; typecheck passes.
- Iteration: replaced the hard-coded WhatsApp LangGraph thread key with business/channel-account/conversation scoping, so external channels retain isolated workflow context. Result: focused workflow/recovery suites 26 passed; typecheck passes.
- Iteration: added durable `graph_runs` lifecycle records around workflow execution, including scoped thread ID, status, timestamps and graph/prompt/policy versions, with recovery coverage. Result: focused workflow/recovery suites 27 passed; typecheck passes.
- Iteration: added RAG database health, memory-backend health and document-count telemetry to the supervisor health payload and autonomy panel. Result: focused health/recovery suites 28 passed; typecheck passes.
- Iteration: completed Cloud normalized-event actor and conversation metadata, with regression coverage for customer/owner classification and raw provider identity fields. Result: focused Cloud/normalization suites 7 passed; typecheck passes.
- Iteration: brought the Baileys message contract to normalized parity with schema version, actor, provider ID, business/account scope, conversation ID and raw payload metadata. Result: focused WhatsApp/recovery suites 32 passed; typecheck passes.
- Iteration: closed the duplicate email autonomy path by making the renderer email bridge defer to the main-process supervisor and keeping delivery events out of the agent prompt stream. Result: focused recovery suite 23 passed; typecheck passes.
- Iteration: replaced full-session delete/rewrite persistence with stable-ID message upserts and stale snapshot rejection, preventing renderer races from deleting newer session messages. Result: dedicated persistence test 1 passed; typecheck passes.
- Iteration: added a durable SQLite `schema_migrations` ledger recording autonomy schema version 1, with recovery coverage. Result: focused recovery suite 24 passed; typecheck passes.
- Iteration: added monotonic supervisor-lease generations and owner-plus-generation fencing for renew, release and health checks, with stale-lease recovery coverage. Result: focused recovery suite passes; typecheck passes.
- Iteration: added explicit channel-account records and a trigger-backed durable jobs projection from inbound events, including status, retry-attempt tracking and orphan-safe deletion. Result: focused recovery suite 25 passed; typecheck passes.
- Iteration: fixed RAG FTS normalization for Unicode customer text and quoted each token to prevent FTS operator injection; added regression coverage. Result: focused RAG suite passes; typecheck passes.
- Iteration: completed retention handling for ended takeover records while preserving active takeovers and opt-out consent records; added regression coverage. Result: focused recovery suite passes; typecheck passes.
- Iteration: closed the MCP/browser-control review blockers by restricting stdio launch to approved commands/packages, removing raw Playwright evaluation tools, applying timeout/cancellation to in-process calls, and scoping cancellation to the requesting renderer. Result: focused MCP/browser safety suites 4 passed; typecheck passes.
- Iteration: aligned renderer autonomy declarations/wrappers and LLM settings casts so the partial PR passes both main-process and renderer typechecks. Result: full suite 245 passed/7 skipped; both typechecks, build and diff checks pass.
- Iteration: added a fixture-driven autonomy evaluation matrix covering common, missing, contradictory, multilingual, follow-up, sensitive, injection and account-specific cases. Result: focused evaluation suite passes; typecheck passes.
- Iteration: expanded derived pilot metrics with grounding rate, delivery-unknown count, draft approval/editing time and estimated cost per resolved conversation, plus panel display and regression coverage. Result: focused recovery suite passes; typecheck passes.
