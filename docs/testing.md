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
- `npm run test` - full suite with live tests auto-skipped unless enabled.
- `npm run test:live` - live suite only (requires valid OpenRouter env vars).
- `npm run test:robust` - unit + live.

## Notes

- These contracts are focused on LLM/runtime behavior and real-world prompt/tool scenarios.
- They do not replace UI/browser E2E tests (Playwright) or WhatsApp socket integration tests.
