# Task 1 implementation report — authenticated Tauri LLM Settings slice

## Result

Implemented the first Settings vertical slice against the independently managed HTTP `agentd`. Tauri now reads runtime status, persists the exact initial LLM preference schema, manages the OpenAI/OpenRouter credentials through the daemon, and requests server-side provider probes. The Tauri host no longer starts or shuts down the historical JSONL pilot process. Electron and `App.tsx` mounting remain unchanged.

## Implementation

- Added strict `GET/PUT /api/v1/settings/llm` handling with the exact `preferredProvider`, `openaiModel`, and `openrouterModel` fields, required defaults, 128-character model-name limits, and rejection of unknown fields.
- Added OpenAI and OpenRouter probe routes in `agentd`. They take no key or URL from the caller, read the matching saved credential through the injected credential-store adapter, use only the fixed `/v1/models` endpoints, disable redirects, bound upstream response data and request time, and return only model count or a generic error.
- Added a typed Rust `AgentdClient` boundary. It resolves and validates the private runtime descriptor, restricts origins to `http://127.0.0.1:<port>`, uses the shared `com.aica.wacopilot` / `agentd_bearer_secret` Keychain entry, and sends only fixed typed routes. Requests use bounded timeouts and response sizes, no proxy, and no redirects. Secret material is not returned to the renderer.
- Replaced Tauri pilot process management with managed HTTP-client state and explicit unavailable status. Retained tray/window behavior and native file/folder picker behavior.
- Updated the Tauri bridge and `TauriPilot` to expose only the two supported providers for this slice, show/save the exact preference fields, and set/check/delete credentials without a credential getter. Credential input is cleared when submitted.
- Removed the JSONL worker from active Tauri resource/build wiring and removed the `build:agentd` package script. Kept the historical pilot source and test evidence; the old JSONL protocol test is skipped and labeled as historical.

## Verification

- `npm run test:agentd` — passed; includes strict preference validation and fixed-endpoint probe tests with fake keychain/provider adapters.
- `npm run test:agentd:credentials` — passed.
- `npx vitest run tests/unit/tauri-native-bridge.test.ts tests/integration/agentd-protocol.test.ts` — passed; legacy JSONL cases skipped as documented.
- `npm run typecheck:renderer` — passed.
- `npm run build:tauri:web` — passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — passed.
- `cargo check --manifest-path src-tauri/Cargo.toml --locked` — passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked` — passed (3 keyring-helper tests and 7 Tauri-host tests).
- The Rust fake-daemon smoke uses a private temporary runtime descriptor and an injected non-real bearer. It exercises status, default and saved preferences, credential set/presence/delete, and a provider-test route over loopback without consulting the real Keychain. The daemon-side tests separately verify fake credential/provider adapters and ensure keys/upstream error text are not returned.
- `git diff --check` — passed.

## Scope and remaining concern

Only OpenAI and OpenRouter connection tests are supported in this slice. Other providers, custom API base URLs, the broader `App.tsx` parity work, and the historical JSONL runtime remain out of scope. The JSONL pilot protocol test is intentionally skipped rather than deleted so prior pilot evidence stays available; it is not an active build or product runtime path.

## Reviewer fixes and follow-up verification

- The Rust host now validates the private descriptor PID as live and owned by the current effective user before reading the shared Keychain bearer, then revalidates the descriptor/process identity immediately before sending. The descriptor carries a separate `processStartedAt` captured from the agentd process; Linux compares `/proc/<pid>/stat` plus boot time, macOS compares locale-fixed `ps lstart`, and unsupported Unix variants fail closed. The host rejects changed PID, runtime start time, process start time, runtime ID, or origin between checks. Missing/ambiguous process data fails closed. `runtimeId` is only compared as descriptor identity; it is not treated as a secret.
- Added loopback regression coverage proving stale same-user PIDs, stale process identities, and (where the test host exposes one) foreign-user PIDs receive neither Authorization nor credential JSON. The fake-daemon smoke now names the live Rust test process in its descriptor and verifies the process-start identity path.
- Narrowed the Rust native credential enum to `openai_api_key` and `openrouter_api_key`. The Tauri bridge validator was already limited to those two; its tests now also explicitly reject Gmail and SMTP keys. The daemon/keyring helper keep their broader backend allowlist for later service slices.
- Required follow-up checks passed: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`; `cargo check --manifest-path src-tauri/Cargo.toml --locked`; `cargo test --manifest-path src-tauri/Cargo.toml --locked` (3 helper and 10 host tests); `npm run test:agentd` (6 tests); `git diff --check`.
- Platform limitation: only `aarch64-apple-darwin` is installed and the migration plan defers Windows/Linux Tauri packaging lanes. Linux and macOS process-start checks are implemented, but only macOS was exercised here. Other Unix variants and non-Unix builds fail closed and cannot use `agentd` until native process identity/token checks are implemented and verified; no bearer or credential body is sent on those paths.
- Residual edge: descriptor/process identity is rechecked immediately before HTTP request construction, but a process can still exit and its PID be reused between that final check and TCP connect. The separate process-start timestamp blocks ordinary stale/reused-PID attacks and the client never sends the bearer when identity cannot be established; eliminating this final local TOCTOU requires a platform-bound transport (for example a Unix-domain socket with peer credentials) or an authenticated challenge/response bound to the accepted socket, which is deferred until the cross-platform agentd transport is finalized.
- A repository-wide `git diff --check` currently reports trailing whitespace in the parent-owned `docs/architecture/tauri-full-migration-plan.md`; targeted Task 1 source checks are clean. That unrelated plan file was not changed by this follow-up.
