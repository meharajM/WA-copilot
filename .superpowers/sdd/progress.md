# SDD Progress — Complete Tauri Product Migration

Branch: `codex/tauri-full-migration`
Started: 2026-09-15

## Status

- [x] Inspect pilot scope and current PR relationships.
- [x] Read app behavior contract and current Tauri API documentation.
- [x] Audit renderer/preload/IPC feature surface.
- [x] Audit service extraction, startup, and data/process ownership.
- [x] Build credential-free, impact-based parity checklist.
- [x] Write full migration architecture and parity gates.
- [x] Agree/record canonical product backend protocol and service ownership.
- [x] Implement first runtime-security foundation slice (Host validation, pairing handoff/throttle, private runtime descriptor, race-safe exclusive ownership); focused daemon tests pass.
- [x] Implement first product vertical slice: Settings/credential lifecycle with an OS-store adapter owned by `agentd` (bounded OpenAI/OpenRouter slice; broader credential parity remains open).
- [x] Run implementer review and QA review for the authenticated draft-only WhatsApp and bounded chat persistence slices; migration hardening review remains blocked by documented platform limitations.
- [ ] Implement daemon-backed provider generation/stream/cancel and mount equivalent product chat flows in Tauri.
- [ ] Add Tauri product UI E2E and parity evidence.
- [ ] Pass data/credential migration and rollback gates.
- [ ] Pass supported-OS release/resource gates.
- [ ] Switch default/retire Electron only after all gates.

Task 2 complete: native-only transactional `settings-persona` metadata cutover landed in `54d59cc5` after independent implementation and concurrency reviews. It has durable restart-safe status, native confirmation, strict schema/secret exclusion, operation fencing, rollback verification, and focused regression coverage. Windows no-reparse descriptor support is still an explicit release blocker; chat and credentials remain deferred.

Task 3 complete in working tree: native-only transactional `chat-history` cutover imports validated Electron sessions/messages into existing agentd chat tables, preserves bounded legacy metadata, fences chat/generation/send admission, persists single-use token/source/backup/recovery state, and supports idempotent apply plus guarded rollback. Browser/Electron behavior and credentials remain unchanged; native bridge/UI invocation, Windows no-reparse support, credential handoff, Electron retirement, and release smoke remain open.

## Findings that shape implementation

1. Tauri currently mounts a pilot, not the product `App.tsx`; current `agentd` JSONL only has health/shutdown.
2. A second `agentd/server.cjs` HTTP service has a different protocol and database; it is tested but is not in the Electron boot path.
3. Electron boot combines UI lifecycle and product backend startup; service modules have direct Electron imports and eager singleton construction.
4. The migration contract includes event behavior and sensitive data, not only method names.
5. Existing service tests help validate domain logic, but there is no Tauri product E2E suite.

## Canonical client/backend boundary

- Product backend: one independently supervised `agentd` user service.
- Product API: evolve the existing paired loopback HTTP service in `agentd/server.cjs` into the authenticated, typed API foundation. Preserve existing endpoints until compatibility/consumers are verified.
- Pilot-only: `src/agentd/index.ts` stdio JSONL health/shutdown process. Do not expand it into a competing product backend.
- Tauri owns desktop-native UI operations and a narrow typed client adapter. `agentd` owns product data and credentials used by background/provider/channel services. Tauri close/quit does not stop the daemon.
- Optional browser client, if retained, must follow the hardened pairing/session/CSRF boundary in `docs/omnichannel-langgraph-architecture.md`.

## Current implementation status — 2026-09-16

- `agentd/server.cjs` now rejects non-exact Host headers, avoids logging pairing codes, and rate-limits pairing attempts.
- A short-lived owner-readable pairing file is exposed only by `npm run agentd:pair-code`; pairing consumes the file.
- `agentd.runtime.json` is atomically written with private permissions and contains only origin, PID, protocol version, startup time, and a non-secret runtime identity.
- SQLite exclusive locking serializes new daemon owners and avoids the previous stale-PID unlink race; the legacy PID marker is checked during transition.
- `npm run test:agentd`, targeted chat/persona tests, renderer typecheck, and `git diff --check` pass.
- OS service registration, keyring-backed daemon auth/provider credentials, full API, data import/rollback, actual Tauri product UI and feature parity remain unimplemented.

## Agent reports

Reports are summarized in `docs/architecture/tauri-full-migration-plan.md` and in this task's audit history. Delegated audit agents made no source changes.
