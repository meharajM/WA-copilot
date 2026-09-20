# Release Readiness

This document defines the production release boundary for AIConsumerAgent.

## Deterministic Gate

Run:

```bash
npm run release:gate
```

The gate requires:

- a clean Git worktree,
- matching `package.json` and `package-lock.json` versions,
- a version newer than the previously published `1.0.0` artifacts,
- clean diff whitespace,
- lint and both TypeScript checks,
- unit and integration suites,
- the Electron Playwright smoke suite,
- a successful production bundle.

Production publish scripts do not support `--skip-checks`. `--skip-build` may reuse artifacts, but all release and artifact-verification gates still run.

The Electron smoke is launched through `scripts/electron-e2e.cjs`. It rebuilds
`better-sqlite3` for the installed Electron ABI, runs the isolated UI/safety
smoke, and restores the host-Node native binding before returning. This keeps
the Electron transition gate reproducible on Windows/macOS/Linux developer
machines that use a different Node ABI.

For an isolated local macOS package check, run `npm run test:e2e:packaged:mac`. It creates an Apple Development-signed QA bundle under `dist/qa-mac`; it is not a public release artifact.

## macOS Distribution

Required before upload:

- Apple Developer Program membership,
- a `Developer ID Application` certificate,
- Apple notarization credentials,
- hardened runtime and the tracked entitlement files under `build/`,
- successful `codesign`, Gatekeeper, and stapler validation for the app,
- successful DMG and stapler validation.

`scripts/verify-macos-release.sh` enforces these requirements. The installer verifies the installed app and never removes quarantine attributes.

## Windows Distribution

Set `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` for the public certificate. Production Windows builds use electron-builder's `forceCodeSigning` option and fail if signing credentials are unavailable.

## External QA Gate

Before publishing a candidate, record evidence for:

1. A dedicated test mailbox connection.
2. One inbound message becoming an email session.
3. Draft-first handling with no duplicate send.
4. One approved reply arriving in the original thread.
5. A sensitive-topic message remaining escalated.
6. A low-confidence non-sensitive message receiving one acknowledgement and creating an owner review draft.

Keep Draft Mode on until these checks pass. Live OpenRouter tests are a separate provider/account gate because they require valid external credentials.

## Artifact Integrity

Publishing writes and uploads `SHA256SUMS` for each platform output directory. Versioned artifacts must be built from the committed release candidate; do not overwrite an existing version.

## Autonomous support pilot boundary

Status: desktop pilot / draft release. This document describes the current implementation, not live-provider approval.

## Shipped in this branch

- Electron main-process supervisor with persistent SQLite state, per-conversation queues, duplicate detection, bounded retries, leases, recovery holds, audit records and owner controls.
- WhatsApp through Baileys, opt-in WhatsApp Cloud API, normalized email, Meta messaging/lead ingress and X DM adapter boundaries.
- Optional WhatsApp Web monitoring with a dedicated persistent Playwright profile, manual QR login, health state, screenshots and human takeover. Autonomous Web outbound remains disabled.
- Observe-only, Draft and Auto-reply modes. Auto-reply requires explicit response permission and host policy approval.
- RAG/memory evidence, confidence/grounding checks, sensitive/account-specific escalation, opt-out handling, service-window/template checks and AI identity disclosure.
- Owner-visible queue, channel, health, metrics, drafts, delivery history, unresolved sends, notifications and emergency pause controls.
- Customer connection onboarding is documented in `docs/customer-connection-onboarding.md`; the production OAuth connection service and HTTPS webhook relay remain deployment work.

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
