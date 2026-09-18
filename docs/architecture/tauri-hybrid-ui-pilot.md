# Tauri hybrid UI pilot: operator guide (historical)

Status: Historical native-boundary pilot. The current browser-first migration is tracked in [`tauri-full-migration-plan.md`](./tauri-full-migration-plan.md). On the current branch, Edge/Chrome is the only product workspace; Tauri is a native companion for OS capabilities and agentd supervision.

This guide covers the original Tauri proving ground only. It is not a product UI specification and must not be used as the browser migration runbook. Electron remains available as a transition fallback while browser/API parity is completed; the current browser runbook is in `tauri-full-migration-plan.md`.

## Prerequisites

- Node.js `>=22.12.0` (`.nvmrc` selects `22.12.0`) and npm.
- Rust `>=1.88.0` and Cargo; the execution plan records Rust `1.94.1` on its baseline host. The locked `keyring` dependency requires Rust 1.88 or newer.
- Platform-native Tauri build prerequisites for your OS, including its desktop WebView and bundler dependencies. Install the current Tauri 2 prerequisites for your platform before building; these differ by OS and are not bundled here.
- A supported Rust host target matching the Node executable available on that machine. Sidecar cross-target preparation is not supported.

Install JavaScript dependencies from the repository root:

```sh
npm ci
```

## Run and build

The scripts below are opt-in and leave Electron commands intact.

```sh
# Prepare the packaged Node agentd runtime/resources, then launch Tauri/Vite
npm run dev:tauri

# Build only the Tauri web frontend (no native app bundle)
npm run build:tauri:web

# Build the frontend, prepare the agentd/keyring resources, and invoke the Tauri bundler
npm run build:tauri
```

`dev:tauri` and `build:tauri` rely on the Tauri configuration's before-dev/before-build hooks to prepare frontend and sidecar inputs. The lockfile records Tauri CLI's platform-specific optional bindings so npm can install the matching native CLI package on supported hosts. A successful `build:tauri:web` validates only the frontend; it does not validate Rust compilation, OS WebView startup, native dialogs/keychain, tray behavior, or packaging. Run the native build on each supported target OS/architecture before treating those paths as verified.

The current Tauri hooks run `scripts/prepare-tauri-agentd.mjs` and the keyring-helper preparation script. They stage the fixed Node runtime, HTTP `agentd` entrypoint and native helper under `src-tauri/sidecar`; generated executable/resource artifacts are build outputs and must not be committed. Preparation verifies Node's OS/architecture against the Rust host triple and rejects a `TAURI_ENV_TARGET_TRIPLE` different from `rustc -vV`'s host triple. Build separately on each target OS/architecture; copying a host Node executable does not produce a cross-compiled runtime. This pilot has no Node runtime download or cross-target packaging workflow.

## Pilot capabilities

The original pilot had a separate React entry point (`tauri.html` / `tauri-main.tsx`) and deliberately did not mount the product `App.tsx`. Its UI exercised:

- Tauri runtime/version reporting and `agentd` health status/events over protocol v1 JSONL.
- Native file and folder selection; the selected path is displayed by the pilot.
- Credential set, existence check, and delete for the typed allowlist in `src/shared/native-bridge.ts`.
- A small renderer/WebView that can be closed/recreated independently of the intended host-owned `agentd` lifecycle.

The web UI and Node sidecar protocol have focused automated coverage, and Rust host commands have unit coverage. The macOS smoke pass below verified release startup, `agentd` readiness, native picker open/cancel behavior, and a disposable Keychain set/check/delete/absence round trip. Closing the release window left its host and sidecar running. Tray Open/Quit, positive path selection, health-failure rendering, and cross-platform behavior still need desktop verification. Tauri's native file-dialog API does not expose a custom confirmation-button label; a Tauri request that supplies `buttonLabel` fails explicitly instead of silently ignoring it. Electron continues to honor its existing picker option. This smoke pass is not production release sign-off. For current behavior, browser product routes use the authenticated `agentd` API and Tauri remains native-only.

## Security and data boundaries

- Treat this as a pilot, not a production credential manager. Use disposable test values only; never paste production credentials while testing.
- Credential values are write-only from the renderer contract: set, check existence, and delete are exposed; no getter is defined. UI clears the input as soon as a set attempt starts. Avoid screenshots, logs, or diagnostics that could capture entered test values.
- Credential keys are allowlisted. Unknown keys, empty values, unavailable native storage, or malformed bridge responses must fail closed. Browser/localStorage fallback is not an acceptable secure-storage path.
- Renderer access is intended to be a small set of typed commands/events. It must not gain generic shell execution, arbitrary process launch, arbitrary filesystem access, or a credential-read command. Tauri JavaScript capability should remain limited to the pilot window and not grant shell-plugin execute permission.
- Development CSP permits only the local Vite HMR WebSocket; the production CSP does not include the dev server origin.
- `agentd` is launched by the native host with a fixed executable and entry point. Its stdout is protocol-only newline-delimited JSON, with a 1 MiB maximum frame. Any future diagnostics should use stderr, which the host currently discards rather than forwarding into app logs. Renderer cannot choose the executable, entry path, or arbitrary RPC method.
- Tauri uses a distinct app identifier/data and credential namespace. It must not read, migrate, or share live Electron databases or credentials during this pilot.
- The pilot must not activate WhatsApp/email senders, OAuth flows, model providers, MCP servers, autonomous workers, or the existing persistence layer. No parity or migration is implied.

## Not supported yet

- Running the full AICA product UI or any of its existing channel, model, MCP, RAG, memory, or autonomous-agent workflows.
- Cross-compiling a sidecar, shipping a separately managed Node installation, production signing/notarization, auto-update, or release packaging guarantees.
- The generated 512×512 app icon and simple tray icon are placeholders; replace them with approved platform artwork before release.
- Importing Electron data or sharing Electron/Tauri data directories.
- Claiming lower total resource use based on WebView footprint alone. The Node sidecar, app host, local model, and model runtime all contribute; whole-process RSS/CPU/GPU/VRAM benchmarking is a later gate.
- Treating a successful Vite build as evidence that native keychain, dialogs, tray, window recreation, or app shutdown work on the target OS.

## Manual verification checklist — macOS smoke pass (2026-09-15); follow-ups pending

Test host: macOS 26.6.2, arm64, `aarch64-apple-darwin`, Node 24.7.0, Rust 1.94.1. Release command: `npm run build:tauri`.

- [x] `npm run dev:tauri` opened the pilot in the macOS WebView.
- [ ] Confirm the Electron app still starts with `npm run dev` (not exercised during this pass).
- [x] The exact branch release app reported Tauri v1.0.0 and `agentd` Ready. Health-failure rendering still needs exercising.
- [x] File/folder buttons opened native pickers; Escape returned the distinct “Selection canceled” state. No file or folder was selected; selected-path display remains unverified.
- [x] With a disposable non-credential test value and an initially empty pilot Keychain slot, set/check/delete/absence all succeeded. The input cleared after save; the UI exposed no value. Do not use production credentials for this test.
- [x] Closing the exact-branch release window left its Rust host and `agentd` sidecar processes running.
- [ ] Use tray Open to recreate at most one window and verify idempotent reopen/PID stability. The desktop automation used for this pass could not reach the macOS status-item menu.
- [ ] Use explicit tray Quit and verify the child exits within the configured grace period. Also test host termination/EOF cleanup.
- [x] `npm run build:tauri` created an Apple Silicon app and DMG at `src-tauri/target/release/bundle/macos/AICA Native Pilot.app` and `src-tauri/target/release/bundle/dmg/AICA Native Pilot_1.0.0_aarch64.dmg`; `hdiutil verify` passed. The Mach-O executable has only a linker ad-hoc signature; the outer app bundle has no `_CodeSignature`, and `codesign --verify --deep --strict` plus `spctl --assess` fail. This is a local test artifact only: do not distribute/open as a downloaded app until Developer ID signing and notarization are configured.
- [x] Packaged contents include the Node runtime and `Resources/sidecar/agentd` files; generated executables, resources and icons remain ignored by Git. Review the CSP/capability source before release, and keep checking that app data and credentials remain separate from Electron.
- [ ] Benchmark full process tree with UI open/closed and local model loaded/unloaded before making resource-use claims.

The repository baseline currently has unrelated failures documented in `tauri-hybrid-ui-execution-plan.md` (including missing `AntigravityAuthService`). Report them separately rather than attributing them to the pilot.
