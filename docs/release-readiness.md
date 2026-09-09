# Autonomous support release readiness

Status: desktop pilot / draft release. This document describes the current implementation, not live-provider approval.

## Shipped in this branch

- Electron main-process supervisor with persistent SQLite state, per-conversation queues, duplicate detection, bounded retries, leases, recovery holds, audit records and owner controls.
- WhatsApp through Baileys, opt-in WhatsApp Cloud API, normalized email, Meta messaging/lead ingress and X DM adapter boundaries.
- Optional WhatsApp Web monitoring with a dedicated persistent Playwright profile, manual QR login, health state, screenshots and human takeover. Autonomous Web outbound remains disabled.
- Observe-only, Draft and Auto-reply modes. Auto-reply requires explicit response permission and host policy approval.
- RAG/memory evidence, confidence/grounding checks, sensitive/account-specific escalation, opt-out handling, service-window/template checks and AI identity disclosure.
- Owner-visible queue, channel, health, metrics, drafts, delivery history, unresolved sends, notifications and emergency pause controls.

## Guarantees and limits

- Observe-only never sends through the autonomous supervisor.
- Every autonomous inbound event is durably recorded before queue processing.
- Outbound intent is claimed before provider dispatch and is idempotent per inbound event.
- Ambiguous sends are quarantined as `delivery-unknown`; they are not automatically replayed.
- Pause All and conversation takeover stop new dispatch and abort in-flight model generation where supported.
- Customer messages cannot authorize arbitrary shell commands, unrestricted filesystem access or raw browser evaluation.
- The desktop worker stops when the owner machine is powered off or the application is explicitly quit. No hosted worker or automatic failover is included.
- Localhost webhook listeners are for controlled development/pilot use. Production webhooks require a separately operated authenticated HTTPS relay.
- Provider availability, account eligibility, message delivery, policy approval, response quality and cost thresholds are not guaranteed by this release.

## Required before production auto-reply

- Verify each provider account, permission, webhook, response-window and delivery-reconciliation path live.
- Complete staged observe-only → draft → narrowly allowlisted auto-reply drills.
- Define the owner escalation contact, response SLA, retention approval and daily charge-review procedure.
- Confirm backup restore, desktop-off behavior, owner takeover, duplicate/stale/ambiguous-send and emergency-pause drills.
