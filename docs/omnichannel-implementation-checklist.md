# Omnichannel support implementation checklist

Date: September 9, 2026

Implements the architecture plan. Complete phases in order. Keep observe-only as the default until phases 0–4 pass.

## Phase 0 — baseline, access and containment

- [x] Record the v1 model: single business, single owner, worker on the owner's machine. (The current Electron pilot is intentionally single-business and single-owner.)
- [x] Decide whether an HTTPS webhook relay is required. (Keep the desktop pilot localhost-only; production Cloud/Meta/X webhooks require an external authenticated HTTPS relay, which is outside this Electron process.)
- [x] Record whether this is our account, a desktop product for customer-owned accounts, or a hosted service. (Current boundary: desktop product for one customer-owned business account; not a hosted or multi-tenant service.)
- [x] Set pilot message, model and channel budgets and maximum conversations. (Host defaults are 100 LLM calls/day, 1,000 outbound messages/day and 100 conversations; all are configurable through bounded environment settings.)
- [ ] Define human escalation contact and SLA; document retention and deletion periods. (Retention defaults to 90 days with explicit preservation of active/recovery records; `AICA_ESCALATION_CONTACT` and bounded `AICA_ESCALATION_SLA_MINUTES` now surface the configured contact/SLA and Auto-reply fails closed until the contact exists, but deployment values and drills remain open.)
- [ ] Verify WhatsApp Business account, number ownership, Cloud API access and Coexistence eligibility.
- [ ] Verify Meta Business, Page and Instagram Professional account access.
- [ ] Verify Instagram, Messenger and Lead Ads permissions and review requirements.
- [ ] Verify X DM access, pricing and spending controls.
- [ ] Audit Gmail OAuth scopes and restricted-scope obligations.
- [ ] Choose approved LLM providers, data regions and local/cloud data handling. (`AICA_LLM_DATA_POLICY_APPROVED` now gates Auto-reply and is visible in health/UI; the actual provider, region, retention and allowed-data decision remains a deployment gate.)
- [x] List every inbound path and every outbound sender. (Repository-derived inventory is documented in `docs/omnichannel-inventory.md`; Baileys, WhatsApp Web, Cloud, email, Meta, X and lead ingress plus autonomous and explicit human senders are enumerated.)
- [x] Find every caller of WhatsAppService.sendMessage and every renderer app:submit-message caller. (The inventory separates the supervisor’s authoritative autonomous path from explicit renderer, IPC, MCP and legacy UI actions.)
- [x] List every session persistence writer and bot/permission state writer. (The inventory covers autonomy SQLite/state, chat-history SQLite, channel stores, secure stores, MCP audit and renderer UI persistence.)
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
- [x] Apply retention and deletion across every local autonomous store. (Supervisor prunes aged messages, inactive conversation metadata, inbound events, decisions, retries, read notifications, usage and operator records; `AICA_RETENTION_DAYS` defaults to 90 and active work is preserved.)

## Phase 2 — LangChain/LangGraph workflow

- [x] Add only required LangChain/LangGraph packages and pin versions. (The three required packages are exact-pinned in package and lock files.)
- [ ] Verify package licenses, Node compatibility and packaged Electron compatibility. (`npm run check:runtime` passes under Node 22; an unsigned macOS arm64 Electron 40 directory build rebuilt `better-sqlite3` and launched the packaged main process. The production audit is down from 27 to 6 findings after non-breaking lockfile updates; the remaining Electron upgrade decision, unfixed libsignal/protobuf and `vosk-browser`/`uuid` advisories, production signing/notarization and GPL-3.0 distribution review remain open. See `docs/package-compatibility.md`.)
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
- [ ] Measure correctness, missed/unnecessary escalation, latency, editing time, recovery time and cost per resolved conversation. (Supervisor now persists owner quality labels for correct, incorrect, unnecessary-escalation and missed-escalation decisions, and exposes review accuracy/escalation precision plus audited recovery-drill count/duration alongside grounding, latency, draft editing, delivery-unknown and cost metrics; completed owner drills and provider-authoritative metrics remain.)
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
- [x] Retry only confirmed pre-send transient failures. (Automatic retry is limited to provider rate-limit responses across WhatsApp, email, Meta and X; network, timeout and 5xx outcomes become delivery-unknown for owner reconciliation.)
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
- [x] Set small message and model-spend caps. (Host-enforced defaults are 100 LLM calls and 1,000 outbound messages per day across WhatsApp, email, Meta and X; `AICA_DAILY_LLM_CAP` and `AICA_DAILY_OUTBOUND_CAP` can lower/raise them within a validated 1–100,000 range.)
- [ ] Review pilot logs and provider charges daily.

## Phase 5 — email parity

- [x] Normalize Gmail/email events into the shared contract. (Email emissions now include schema version, channel/actor identity, normalized content, subject and thread headers while preserving the legacy email fields.)
- [x] Preserve Message-ID, In-Reply-To and References. (Shared normalization preserves all three and derives a stable conversation ID from References, In-Reply-To, Message-ID or the provider ID.)
- [x] Suppress self-reply loops, auto-replies and mailing-list noise. (Email ingestion rejects self/stale/already-handled messages, auto-submitted replies, bulk/list precedence and mailing-list/autoresponder headers.)
- [ ] Reuse narrow OAuth scopes and document restricted-scope obligations. (Gmail requests only `openid`, `email`, `gmail.readonly` and `gmail.send`; the code-level scope set and Google verification/security-assessment obligations are documented in `docs/gmail-oauth-scopes.md`, while Cloud-project verification remains open.)
- [x] Use the shared send/draft policy and outbox. (Normalized email events enter the supervisor queue and share observe/draft/auto policy, RAG decisioning and durable `outbound_sends` records; successful Gmail/MCP provider IDs are retained. Provider reconciliation remains separately tracked.)
- [x] Handle token expiry, revocation, polling reconciliation and push-watch renewal. (Gmail token refresh and 401/403 failures surface explicit error state, the incremental cursor does not advance after a failed detail fetch, and optional `GMAIL_PUBSUB_TOPIC` watches renew at startup and before expiry. Provider delivery reconciliation remains separately tracked.)
- [ ] Test threading, bounces, attachments and restart recovery. (Bounce filtering now runs on both MCP and Gmail API ingress; attachment metadata is normalized without downloading file bytes; the host now escalates any external message with attachment/media metadata before model generation; queued normalized email payloads reconstruct across restart; binary scanning/retrieval and complete end-to-end coverage remain.)

## Phase 6 — Instagram, Messenger, ads and X

- [ ] Choose one documented Meta login flow per adapter and minimum permissions. (`docs/meta-login-permissions.md` recommends the operator-provisioned Facebook Login/Page-token route for the current Graph transport and explicitly excludes unused comment, publishing, ads, lead-retrieval and marketing permissions; live Meta Dashboard scope confirmation and review remain open.)
- [x] Implement independent Instagram and Messenger adapters. (Official Graph signature verification, opt-in localhost startup, inbound normalization and host-side text-send transport are separated by channel; account-specific permissions and live delivery tests remain external gates.)
- [x] Implement owner/takeover signals independently per channel. (Meta account echoes and configured X-account DM echoes normalize as owner messages and pause the customer conversation; live account identity verification remains external.)
- [x] Apply channel-specific windows, limits and error handling. (Meta messages use a bounded 24-hour auto-response window, 2,000-character send bound and fail-closed outside-window policy; 429/5xx propagation is covered. Live provider matrices remain external.)
- [x] Ingest Meta lead events read-only with source, campaign, form and consent evidence. (Leadgen events normalize and persist as attribution records with source/page/form/campaign IDs and no message body; Meta delivery/read receipts now also reconcile through the signed webhook path.)
- [x] Do not treat a lead as unrestricted messaging consent. (Normalized lead records carry `messagingConsent: false`; no lead-to-message path exists.)
- [x] Keep ad creation, budget and audience changes unreachable from the customer graph. (The autonomous graph receives only a normalized message and host decision callback; no Meta marketing adapter, customer-facing MCP client, or ad/budget/audience mutation tool exists. See `docs/omnichannel-inventory.md`.)
- [ ] Verify X DM access, endpoint pricing and spending limits. (Adapter targets the documented OAuth1 user-context DM endpoint, implements CRC/signature verification and opt-in localhost wiring; account access and current commercial limits remain an external gate.)
- [x] Keep public X replies in draft/approval mode. (No public-post transport is exposed; only explicit DM transport exists.)
- [x] Meter X usage separately and block on budget exhaustion. (Outbound usage records channel, host caps X at five active/delivered/ambiguous sends per conversation per 24 hours before provider access, and the owner panel shows today’s outbound counts by channel; X-specific commercial/provider limits remain external.)

## Phase 7 — UI, MCP and hosted operation

- [x] Replace contradictory bot toggles with authoritative supervisor state. (The autonomy panel separates mode selection from explicit Response Permission; the main-process supervisor is authoritative.)
- [x] Show execution location, mode, permission, ownership, queue, active job and last error. (Panel shows Electron-main execution location, mode, explicit permission, selected transport, LLM/RAG/memory health, channel health, queue, active job, lease ownership and last error.)
- [x] Show drafts, evidence, approval expiry, takeover and delivery-unknown states. (Panel now shows persisted draft hashes/expiry, recent decision evidence, active human takeovers with source/time, bounded unresolved-outbox and delivery-history views, resume controls, and delivery-unknown actions.)
- [x] Add restart recovery, retention/deletion and cost views. (Crash recovery reconstructs queued work, retention protects active/recovery records, owner views expose usage/cost history, and startup restore integration verifies staged-database swap, pre-restore preservation and recovery hold.)
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
- [x] Sensitive/account-specific intents use the intended human path. (`AutonomyDecision` detects sensitive topics, prompt injection and account-specific requests; the supervisor creates escalated decisions with no response text, and policy tests cover the human path. Live pilot confirmation remains separate.)
- [ ] Response-window and template behavior is verified live.
- [x] Duplicate, stale-decision and ambiguous-send tests pass. (`tests/integration/autonomy-recovery.test.ts` covers repeated inbound dedupe and delivery-unknown requeue/quarantine; `tests/integration/autonomy-decision.test.ts` covers stale revisions and ambiguous provider classification.) Live-provider validation remains separately tracked in the pilot matrix.
- [x] Opt-out, takeover and Pause All are immediate. (Ingress opt-out/takeover handling and abortable global/conversation pause controls are covered by recovery tests; live pilot confirmation remains an operational gate.)
- [ ] Cost caps and provider limits are active.
- [x] Retention/deletion and escalation procedures are documented. (`docs/release-readiness.md` and `docs/escalation-operations.md` document retention, deletion, escalation contact/SLA configuration and operator responsibilities; deployment-specific values and drills remain item 13/152.)
- [ ] Owner has completed pause and recovery drills.
- [x] Release documentation states actual channels and guarantees. (See `docs/release-readiness.md`; live-provider approval, production relay and pilot gates remain explicitly open.)

## Verified status — September 10, 2026

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

- Autonomy, workflow, policy, Cloud API, webhook and recovery tests remain covered by the focused suites; the latest full suite is 39 test files passed, 1 skipped, 280 tests passed, 7 skipped.
- Production build: passing.
- Full typecheck: passing (`npx tsc --noEmit`).
- Full test suite: 39 files passed, 1 skipped; 280 tests passed, 7 skipped (287 total).

Known limitations and failed baseline checks:

- The earlier baseline TypeScript, secure-IPC contract and resolution-audit failures are resolved; the current full suite and typecheck pass.
- Cloud runtime selection is explicitly opt-in (`WHATSAPP_TRANSPORT=cloud` or stored Cloud selection); secure credential allowlisting/UI and common outbound transport selection are implemented, but common inbound switching and HTTPS relay deployment are not complete.
- Supervisor startup now crash-resumes only a previously running, unpaused, non-recovery-held state; first launch and clean shutdown remain stopped until explicitly started.
- Autonomy state and autonomous processing are main-process authoritative; renderer persistence remains only for human UI/chat state, with stale snapshot protection in the chat persistence service.
- Complete outbox approval/reconciliation is not complete; core states, draft evidence, approved-template registry/payload generation, payload hashes and explicit retry/quarantine handling for `delivery-unknown` are now recorded.
- Full media download/attachment scanning, full health telemetry, multi-worker leases and hosted operation are not complete; Cloud media metadata/replies/owner echoes are now normalized and media without text is human-escalated. WhatsApp Web now has an isolated persistent-profile connector with manual takeover, but live QR/session selectors and provider delivery validation remain.
- WhatsApp Web selection is explicit and fail-closed: it does not fall through to Baileys, and its outbound path is manual-only pending live send validation. The connector can poll incoming DOM message containers with dedupe under an operator-supplied conversation ID and route them through IPC into the supervisor; live selector/session validation remains.
- Legacy direct WhatsApp text/media IPC sends are now blocked whenever Cloud or Web is selected, preventing a hidden Baileys bypass.
- WhatsApp Web operator controls are exposed through IPC for state, start/stop, human takeover, and bounded failure capture.
- Current LangGraph graph has one decision node; it is a durable workflow seam, not the final multi-node policy/RAG/approval graph.
- Delivery reconciliation boundary: WhatsApp Cloud and Meta signed webhook callbacks are wired to durable delivery history; Gmail/MCP email currently exposes send acknowledgment and bounce filtering, while X currently has no provider delivery callback path. Live provider-authoritative reconciliation remains open and is not inferred from a successful send response.

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
- Iteration: audited repository call sites and added `docs/omnichannel-inventory.md` covering inbound sources, autonomous and explicit human outbound senders, session persistence, channel stores, permission state and known limits. Result: checklist inventory gates complete; live provider and packaged-app verification remain external gates.
- Iteration: added `npm run check:runtime` and `docs/package-compatibility.md` for Node/Electron/native-module/license evidence. Result: the check correctly fails on the current Node 20.20.2 host and missing Electron binary; compatibility remains an explicit release gate.
- Iteration: verified and documented the customer-graph capability boundary. Result: ad creation, budget, audience, campaign and boost mutations have no adapter or autonomous tool path; Meta lead ingestion remains read-only.
- Iteration: added durable owner quality reviews with four labels, audited review actions, retention cleanup, IPC/panel controls, and derived accuracy/escalation-precision metrics. Result: recovery test suite 27 passed; full suite 256 passed/7 skipped; recovery-time drills and provider-authoritative metrics remain open.
- Iteration: derived recovery-drill count and average recovery duration from audited recovery enter/clear actions and surfaced them beside existing pilot metrics. Result: focused recovery suite 28 passed; owner drill completion and provider-authoritative metrics remain open.
- Iteration: audited the Gmail OAuth scope set and documented its least-privilege rationale plus current Google verification and restricted-scope obligations. Result: code-level scope inventory is explicit; Cloud-project verification remains an external release gate.
- Iteration: added startup restore integration coverage that boots from a staged autonomy database, preserves the pre-restore database, removes the staging file and enters a paused recovery hold. Result: backup import integration is verified; hosted/desktop-off drills remain open.
- Iteration: reconciled the duplicate, stale-decision and ambiguous-send exit gate against passing recovery/decision integration tests, while retaining the separate live-provider pilot gate.
- Iteration: added bounded escalation contact/SLA configuration, health/panel visibility and default-value regression coverage; deployment-specific contact, procedure and drill evidence remain open.
- Iteration: made the escalation contact a host-side prerequisite for Auto-reply with response permission; missing contact now fails closed and is covered by recovery integration tests.
- Iteration: exposed the existing per-channel outbound usage aggregation through owner IPC/preload and the autonomy panel, with X-channel regression coverage; provider-commercial limits remain external.
- Iteration: reconciled email shared-policy/token-recovery and Meta/X adapter/window/takeover implementation gates against shipped code and tests; retained separate live-provider reconciliation and account-access gates.
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
- Iteration: added release-readiness documentation covering actual channels, operating modes, guarantees, limits and production prerequisites. Result: documentation verified against current transport/policy implementation; full checks pending.
- Iteration: reconciled the final-gate checklist with shipped human-path escalation and retention/escalation procedures. Result: sensitive, prompt-injection and account-specific requests, plus documented retention/escalation operations, are closed; live pilot, deployment and provider gates remain open.
- Iteration: documented the actual Meta pilot login boundary as operator-provisioned tokens plus signed localhost webhooks; deliberately retained the exact permission, review and account-eligibility gate until verified in Meta Business tools.
- Iteration: reran the runtime gate under the declared Node 22 runtime and restored the Electron 40 postinstall payload; updated evidence, while retaining native rebuild, packaged launch and GPL-3.0 distribution review as open gates.
- Iteration: built an unsigned macOS arm64 Electron 40 directory artifact, rebuilt `better-sqlite3` for Electron, and verified packaged main-process startup; restored the Node 22 test ABI afterward. Production signing/notarization and license review remain open.
- Iteration: documented that unattended decisions currently use only the main-process Gemini path, while renderer WebLLM/Ollama/OpenAI/OpenRouter options are interactive-only; provider, region, residency, retention and spend approval remain an explicit production gate.
- Iteration: applied available non-breaking production dependency security updates and reran the audit. Result: findings reduced from 27 to 6; Electron upgrade, unfixed libsignal/protobuf, unfixed `vosk-browser`/`uuid`, licensing and release signing remain explicit gates.
- Iteration: re-audited the checklist against current source and full-suite evidence. Result: corrected stale test counts/date and recorded the exact delivery-reconciliation boundary; live email/X provider evidence remains open.
- Iteration: made delivery callbacks fail closed for unknown status, invalid timestamps, provider IDs and channels instead of treating them as `sent`; rejected callbacks are audited and regression-tested. Result: malformed events cannot falsely advance outbound state, while live provider reconciliation remains open.
- Iteration: added an explicit `AICA_BAILEYS_EXPERIMENTAL_APPROVED` gate for Baileys Auto-reply, enforced on mode enable and restart, with health visibility and policy coverage. Result: observe/draft remain available, while production unattended sending defaults to the safer Cloud API path.
- Iteration: surfaced the Baileys experimental approval state in the operator autonomy panel alongside LLM data approval. Result: the owner can see why Baileys Auto-reply is blocked without inspecting environment files.
- Iteration: closed the persisted-state restart gap by rechecking escalation contact, LLM data approval and Baileys experimental approval before starting a saved Auto-reply state; added recovery coverage. Result: removing a safety prerequisite while the app is stopped cannot silently re-enable sending on restart.
- Iteration: preserved provider `read` receipts as `read` delivery-history events while keeping the outbound send state at `delivered`; added regression coverage. Result: owner audit history no longer loses the provider’s receipt detail.
- Iteration: made delivery callback history idempotent for repeated provider events using provider ID, channel, status and provider timestamp; duplicates are audited and not inserted twice. Result: webhook retries cannot inflate delivery history.
- Iteration: made outbound delivery state monotonic so late `sent` callbacks cannot regress `delivered`/failed work; valid events remain in history and stale transitions are audited. Result: out-of-order provider callbacks cannot reopen or downgrade completed sends.
- Iteration: applied the Auto-reply prerequisite check to global and conversation resume paths, closing a persisted-state bypass that could drain queues after approval removal. Result: restart, resume and per-conversation resume now fail closed consistently.
- Iteration: scoped disconnect degradation and final send blocking to the Baileys transport; Cloud API templates/free-form sends and email/Meta queues remain independent. Result: local Baileys outages cannot trigger sends or stop unrelated transports.
- Iteration: added a Baileys dispatch hold to stop disconnected drain-loop spinning; queued work remains retained until the channel reconnects and the owner explicitly resumes. Result: reconnect recovery is bounded and cannot silently replay queued messages.
- Iteration: added host-side channel validation to approved WhatsApp template sends so email/Meta/X inbound records cannot reach the Cloud WhatsApp template operation; added regression coverage.
- Iteration: made an explicit Start release a prior Baileys dispatch hold when the channel is connected, preserving the hold for passive reconnects; recovery behavior remains owner-controlled.
- Iteration: closed the email attachment safety gap by escalating external messages with attachment/media metadata before model generation, with integration coverage; binary retrieval/scanning remains intentionally disabled.
- Iteration: selected and documented the recommended Meta pilot login boundary (operator-provisioned Facebook Login/Page token for Page-backed Messenger and Instagram), with least-privilege exclusions and official verification links; live scope/review confirmation remains open.
- Iteration: added `docs/omnichannel-live-pilot-matrix.md` with provider prerequisites, operator actions, expected safety outcomes and evidence fields for the remaining live-account, staging, recovery and charge-review gates.
- Iteration: added an explicit `AICA_LLM_DATA_POLICY_APPROVED` fail-closed prerequisite for Auto-reply and surfaced its state in health/UI; provider, region, residency and retention approval remain deployment evidence gates.
- Iteration: resolved stale merge-conflict markers in `.env.example` and documented safe defaults for Gemini, LLM data approval, escalation contact/SLA and business scope.
- Iteration: refreshed the verification snapshot from the latest full run: 39 files passed, 1 skipped; 280 tests passed, 7 skipped (287 total); no implementation status changed.
- Iteration: corrected shared delivery-failure audit messages to identify the actual channel instead of always saying WhatsApp; recovery regression coverage remains green with 33 focused tests.
- Iteration: applied the daily outbound cap to email, Meta and X dispatch as well as WhatsApp; over-cap external work is durably failed, audited and owner-notified before provider calls.
- Iteration: added bounded exponential retry handling for confirmed pre-send rate-limit responses on email, Meta and X; ambiguous/network/provider-acceptance uncertainty remains delivery-unknown and is never auto-retried.
- Iteration: made external retry backoff honor Pause All, conversation takeover and lease loss by deleting the unaccepted send claim and requeueing the inbound event before another provider call; regression coverage verifies the pause race.
- Iteration: scoped provider delivery reconciliation by provider ID and inbound channel, preventing a cross-channel ID collision from mutating the wrong outbound record; added regression coverage.
- Iteration: added a shared drain-boundary failure handler for WhatsApp, email, Meta and X so thrown model/provider errors durably fail the inbound event, clear the active job, audit and notify the owner instead of leaving work wedged; recovery coverage added.
- Iteration: quarantined interrupted pending/authorized/sending outbound claims as `delivery-unknown` before restart queue restoration, preventing a stale claim from silently suppressing recovery; added regression coverage.
- Iteration: made external `delivery-unknown` retry fail closed when the original normalized payload is missing, avoiding a malformed WhatsApp fallback on email/Meta/X; the unresolved record remains available for quarantine or manual reconciliation.
- Iteration: aligned external error handling with WhatsApp so 5xx/network/transient provider outcomes become `delivery-unknown` instead of ordinary `failed`; added regression coverage for a 503 response.
- Iteration: made every successful autonomous send require a provider message ID; missing IDs now become `delivery-unknown`, are audited/owner-notified and cannot be falsely recorded as reconciliable `sent` work.
- Iteration: extended provider-ID enforcement to owner-triggered approved templates; a successful Cloud template call without an ID now remains `delivery-unknown` and surfaces an explicit retry/quarantine error.
- Iteration: tightened delivery callback validation to reject whitespace-only provider IDs and non-positive timestamps before event persistence; malformed callback regression coverage added.
- Iteration: made delivery callback validation type-safe for non-string runtime provider IDs, preventing malformed webhook payloads from throwing before the audit path; regression coverage added.
- Iteration: stopped each channel drain after its first thrown processing failure, preserving later queued messages for explicit recovery instead of cascading work while degraded; regression coverage added.
- Iteration: audited and owner-notified fail-closed external retry requests when the original payload is missing, preserving the unresolved delivery record for manual reconciliation.
- Iteration: added an owner-only `retryJob` control for failed processing/provider jobs, validating the durable payload and channel, removing only a failed outbound claim, and requeueing without auto-resuming a paused supervisor; IPC/preload wiring and regression coverage added.
- Iteration: added the authenticated `internal-autonomy` MCP namespace for bounded agent status, channel health, pause/resume, retry-job and reconnect controls, reusing the existing supervisor policy and MCP authorization/timeout/audit pipeline.
- Iteration: extended `internal-autonomy` MCP with bounded machine health, queue status, recent failures, diagnostics and controlled browser-surface tools; browser access delegates to human intervention and remains evaluation-free.
- Iteration: aligned internal MCP calls with external calls by auditing successful, rejected and timed-out internal operations, including autonomy controls; failures now return bounded errors instead of escaping IPC unrecorded.
- Iteration: expanded MCP recent-failure and diagnostics results to include durable failure, budget and recovery notifications in addition to unresolved outbound work; bounded listing and regression coverage added.
- Iteration: extended supervisor health with non-secret Meta/X configuration signals and per-channel WhatsApp/email/Meta queue depths; regression coverage added.
- Iteration: surfaced Meta/X configuration and per-channel queue depths in the owner autonomy panel; renderer type coverage remains green.
- Iteration: added `.nvmrc` for the declared Node 22.12.0 minimum; the runtime check now has an explicit project-selected runtime instead of relying on the host default.
- Iteration: extended owner-message takeover handling to normalized email ingress; owner replies now durably pause the email conversation and are covered by recovery tests.
- Iteration: fixed WhatsApp self-echo handling so owner identity detection runs before the `isFromMe` filter; real owner echoes now pause the conversation and are regression-tested.
- Iteration: keyed WhatsApp owner takeovers to the customer recipient rather than the owner sender JID; regression coverage now verifies the correct conversation is paused.
- Iteration: made the reconnect control honor the selected WhatsApp transport; Cloud/Web selections no longer invoke Baileys, with regression coverage for the fail-closed boundary.
- Iteration: surfaced the persisted last-processed message ID in the owner autonomy panel alongside active job and queue state.
- Iteration: kept Auto-reply mode selection separate from response permission; selecting Auto-reply no longer grants send authority without the explicit permission control.
- Iteration: aligned identity-matched WhatsApp owner messages with self-echo handling so both pause the recipient’s customer thread; legacy takeover coverage now asserts the correct JID.
- Iteration: prevented the Start control from bypassing an emergency Pause All hold; Start now reacquires/monitors the supervisor while remaining paused until explicit Resume.
- Iteration: changed maximum-conversation admission to count only conversations updated within the configured retention window, so historical inactive rows cannot exhaust the active-cap budget; added regression coverage.
- Iteration: extended retention pruning to remove stale inactive conversation metadata while preserving queued work, unresolved sends, pending drafts and active takeovers; added regression coverage.
- Verification iteration: full repository checks passed after the recovery and retention slices: 39 test files passed, 1 skipped; 273 tests passed, 7 skipped; main/renderer typechecks and build passed; lint reported 0 errors with existing warnings.
