# Testing Guide

## Goals

- Use `docs/app-behavior.md` as the manual QA and product-behavior contract.
- Catch parser/logic regressions quickly with deterministic unit tests.
- Catch real provider/API regressions with live OpenRouter contract tests (no mocked LLM responses).

## Test Layers

1. Unit tests (`tests/unit`)
- Fast and deterministic.
- Cover JSON/tool-call parsing and WhatsApp identity normalization.

2. Integration contracts (`tests/integration`)
- IPC channel parity: preload `invoke` channels must map to main `handle` channels.
- LLM routing/orchestrator provider selection behavior.
- Chat store session/processing lifecycle behavior.
- WhatsApp renderer integration behavior (target resolution + admin/customer prompts).
- Resolution-audit inactivity decision logic.

3. Live LLM contract tests (`tests/live`)
- Real calls to OpenRouter via `callOpenAI(..., isOpenRouter=true)`.
- Validate:
  - non-empty chat responses,
  - multi-turn context continuity,
  - prompt-injection guardrail behavior,
  - tool-call JSON recovery paths (single and multi-command),
  - native tool-calling paths for workflow-like scenarios (optional strictness),
  - per-run artifacts saved to `test-results/live/` for regression tracking.

4. Electron UI smoke tests (`tests/e2e`)
- Launch the built Electron application with isolated user data.
- Block external email and WhatsApp side effects.
- Verify startup, navigation, the settings shell, Email Channel controls, safe defaults, Gmail presets, and the Drafts view.
- Fail on renderer page errors or unexpected external channel calls.

## Environment Setup

Copy `.env.example` to `.env` or `.env.test`, then set:

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`

Optional:

- `LIVE_LLM_TESTS=true` to enable live tests.
- `LIVE_EXPECT_NATIVE_TOOLS=false` if your selected model does not support native function calling.

## Commands

- `npm run test:unit` - unit tests only.
- `npm run test:integration` - integration contract tests only.
- `npm run test:agentd:speech` - bounded speech-model cache/download tests (streaming, size, URL and digest gates).
- `npm run test` - full suite with live tests auto-skipped unless enabled.
- `npm run test:live` - live suite only (requires valid OpenRouter env vars).
- `npm run check:live-prereqs` - secret-safe readiness preflight; loads `.env.test.local`, `.env.test`, then `.env`, reports the selected transport and required variable names without printing values, requires an extension token for `WHATSAPP_TRANSPORT=web`, and requires an HTTPS relay origin/business for `WHATSAPP_TRANSPORT=cloud`. Set `AICA_EMAIL_PROVIDER=imap-smtp` (plus `AICA_EMAIL_*`/`EMAIL_*` mailbox fields) or `AICA_EMAIL_PROVIDER=gmail-api` with `AICA_EMAIL_AUTH_MODE=google-oauth` to validate the applicable email configuration. Set `AICA_AGENTD_ORIGIN` or `AICA_AGENTD_ENDPOINT` to validate and probe the agentd `/healthz` endpoint; set `AICA_EXTENSION_BRIDGE_HEALTH_URL` to probe a configured Web bridge session. These checks prove local configuration/readiness only; mailbox login, browser session evidence, provider ownership, relay reachability, and delivery evidence remain live gates.
- `npm run test:relay` - public relay signature, durable-before-ack, polling/lease, acknowledgement, TTL expiry and no-send-path tests.
- `npm run test:robust` - unit + integration + live.
- `npm run test:e2e` - deterministic Electron UI smoke test.
- `npm run test:playwright` - same Electron UI smoke test, driven by Playwright.
- `npm run test:e2e:packaged:mac` - run the smoke suite against the packaged macOS app.
- `npm run test:mock` - intentionally fails because no separate mocked E2E suite exists.
- `npm run test:speech` - intentionally fails because no speech E2E suite exists.
- `npm run release:gate` - clean-tree, version, lint, typecheck, unit, integration, speech-model, Electron E2E, browser E2E, and build gate.

## Notes

- The Electron smoke suite is deterministic and side-effect free; it does not replace a real mailbox round trip or WhatsApp socket integration test.
- Live OpenRouter tests remain an explicit external-provider gate and are not part of the deterministic release gate.
