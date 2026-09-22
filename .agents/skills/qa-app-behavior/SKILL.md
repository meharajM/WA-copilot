---
name: qa-app-behavior
description: Verifies the app against the current behavior contract in docs/app-behavior.md and drives impact-based manual QA. Use when testing app behavior, doing end-to-end QA, validating a feature area after changes, or checking product-contract drift in this repo.
---

# QA App Behavior

## Quick Start

1. Read `/Users/meharaj/WA-copilot/docs/app-behavior.md` first.
2. Run `./.agents/skills/qa-app-behavior/scripts/preflight.sh`.
3. Select the impacted areas instead of testing randomly.
4. Compare observed behavior to `docs/app-behavior.md`, not to memory or older manuals.

Default runtime boundary: browser workspace in Windows Edge/Chrome. Do not launch `/Applications/AIConsumerAgent.app`, a packaged Electron binary, or an Electron dev window for browser UX validation. Use Tauri only to validate native-host capabilities; it must not be used as a second product workspace.

## Workflow

### 1. Establish scope

- Identify which feature areas changed.
- Always include startup, navigation, and the directly impacted channel or settings area.
- If channel logic changed, include the draft/escalation/background automation behavior tied to that channel.

### 2. Run preflight

- Stop if `typecheck`, `test:unit`, `test:integration`, or `build` fail.
- Confirm whether you are testing the browser bundle served by `agentd`, the Tauri native diagnostics surface, or the Electron transition client.
- For browser QA, require `dist/tauri.html`, a live loopback `agentd`, and the visible pairing flow before checking product screens.

### 3. Verify by contract

- For each area, record:
  - expected behavior from `docs/app-behavior.md`
  - exact steps executed
  - observed result
  - pass/fail
- Treat any difference as one of:
  - config issue
  - implementation bug
  - contract drift

### 4. Prioritized area checklist

- `Startup`: dependency gate, first render, shell loads
- `Browser boundary`: daemon readiness, pairing, reload/session continuity, no native/product-window duplication
- `Navigation`: sidebar, settings shell, command palette
- `Chat`: session creation, per-session isolation, attachments, voice if touched
- `WhatsApp`: connection, gating toggles, inbound handling, escalation, follow-up
- `Email`: auth mode, test connection, enablement, inbound gating, draft/send behavior
- `Brain`: ingest, listing, delete, knowledge test drive
- `Memory`: backend, stats, inspector, migration if relevant
- `LLM`: provider selection and availability checks
- `MCP`: add/edit/connect/disconnect/troubleshoot if changed
- `Polish`: logs, appearance, about, non-fatal UI regressions

### 5. Output format

- Summarize passes briefly.
- List failures first, with exact mismatch against `docs/app-behavior.md`.
- Call out any area where the document is wrong and should be updated.

## Rules

- Do not mark a test passed because it "seems fine".
- Do not use old PDF/manual wording as authority when it conflicts with `docs/app-behavior.md`.
- Prefer real Edge/Chrome UI verification for browser behavior changes, not test-suite output alone.
- Do not report an Electron/macOS walkthrough as browser evidence.
- If behavior changed intentionally, update `docs/app-behavior.md` in the same workstream.
