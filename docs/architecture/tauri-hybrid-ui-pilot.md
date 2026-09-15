# Tauri hybrid UI pilot: operator guide

Status: implementation and native-runtime verification in progress on `codex/tauri-hybrid-ui`.

This guide covers the opt-in Tauri proving ground only. Electron remains the supported application path. The pilot does not switch the default `dev` or `build` scripts and is not a replacement for the existing app.

## Prerequisites

- Node.js `>=22.12.0` (`.nvmrc` selects `22.12.0`) and npm.
- Rust and Cargo; the execution plan records Rust `1.94.1` on its baseline host.
- Platform-native Tauri build prerequisites for your OS, including its desktop WebView and bundler dependencies. Install the current Tauri 2 prerequisites for your platform before building; these differ by OS and are not bundled here.
- A supported Rust host target matching the Node executable available on that machine. Sidecar cross-target preparation is not supported.

Install JavaScript dependencies from the repository root:

```sh
npm ci
```

## Run and build

The scripts below are opt-in and leave Electron commands intact.

```sh
# Compile agentd, stage the Node runtime + agentd resources, then launch Tauri/Vite
npm run dev:tauri

# Build only the Tauri web frontend (no native app bundle)
npm run build:tauri:web

# Compile the agentd TypeScript entry point
npm run build:agentd

# Prepare target-specific sidecar files explicitly
npm run prepare:tauri:sidecar

# Build the frontend, prepare the sidecar, and invoke the Tauri bundler
npm run build:tauri
```

`dev:tauri` and `build:tauri` rely on the Tauri configuration's before-dev/before-build hooks to prepare frontend and sidecar inputs. If those hooks are unavailable, the native host/config task has not landed or is incomplete; do not infer a successful native build from `build:tauri:web` alone.

The sidecar preparation script compiles `src/agentd/index.ts`, copies the current `process.execPath` to Tauri's target-triple-named external binary, and stages the compiled agentd entry under `src-tauri/sidecar`. Generated executable/resource artifacts are build outputs and must not be committed. The script rejects a `TAURI_ENV_TARGET_TRIPLE` different from `rustc -vV`'s host triple. Build separately on each target OS/architecture; copying a host Node executable does not produce a cross-compiled runtime. This pilot has no Node runtime download or cross-target packaging workflow.

## Pilot capabilities

The pilot has a separate React entry point (`tauri.html` / `tauri-main.tsx`) and deliberately does not mount the product `App.tsx`. Its UI exercises:

- Tauri runtime/version reporting and `agentd` health status/events over protocol v1 JSONL.
- Native file and folder selection; the selected path is displayed by the pilot.
- Credential set, existence check, and delete for the typed allowlist in `src/shared/native-bridge.ts`.
- A small renderer/WebView that can be closed/recreated independently of the intended host-owned `agentd` lifecycle.

The web UI and Node sidecar protocol have focused automated coverage. Rust command wiring, packaging, OS credential-store behavior, picker behavior, tray/window lifecycle, and native WebView operation are pending verification until the Tauri host is integrated and exercised on a desktop. No manual native runtime verification is claimed by this guide.

## Security and data boundaries

- Treat this as a pilot, not a production credential manager. Use disposable test values only; never paste production credentials while testing.
- Credential values are write-only from the renderer contract: set, check existence, and delete are exposed; no getter is defined. UI clears the input as soon as a set attempt starts. Avoid screenshots, logs, or diagnostics that could capture entered test values.
- Credential keys are allowlisted. Unknown keys, empty values, unavailable native storage, or malformed bridge responses must fail closed. Browser/localStorage fallback is not an acceptable secure-storage path.
- Renderer access is intended to be a small set of typed commands/events. It must not gain generic shell execution, arbitrary process launch, arbitrary filesystem access, or a credential-read command. Tauri JavaScript capability should remain limited to the pilot window and not grant shell-plugin execute permission.
- `agentd` is launched by the native host with a fixed executable and entry point. Its stdout is protocol-only newline-delimited JSON, with a 1 MiB maximum frame; diagnostics belong on stderr. Renderer cannot choose the executable, entry path, or arbitrary RPC method.
- Tauri uses a distinct app identifier/data and credential namespace. It must not read, migrate, or share live Electron databases or credentials during this pilot.
- The pilot must not activate WhatsApp/email senders, OAuth flows, model providers, MCP servers, autonomous workers, or the existing persistence layer. No parity or migration is implied.

## Not supported yet

- Running the full AICA product UI or any of its existing channel, model, MCP, RAG, memory, or autonomous-agent workflows.
- Cross-compiling a sidecar, shipping a separately managed Node installation, production signing/notarization, auto-update, or release packaging guarantees.
- Importing Electron data or sharing Electron/Tauri data directories.
- Claiming lower total resource use based on WebView footprint alone. The Node sidecar, app host, local model, and model runtime all contribute; whole-process RSS/CPU/GPU/VRAM benchmarking is a later gate.
- Treating a successful Vite build as evidence that native keychain, dialogs, tray, window recreation, or app shutdown work on the target OS.

## Manual verification checklist — pending

Run only after the Tauri Rust host/config is present and a desktop build succeeds. Record OS, architecture, Rust target, Node version, and exact command for each run.

- [ ] `npm run dev:tauri` opens the pilot in the OS WebView; the Electron app still starts with `npm run dev`.
- [ ] UI reports Tauri version and `agentd` reaches ready; health updates and worker failure are visible.
- [ ] File/folder buttons open native pickers; cancel is distinct from an error and no arbitrary file operation is exposed.
- [ ] With disposable data only, set a test credential, check existence, delete it, then verify absence using only the status API. Confirm no credential getter, localStorage value, or plaintext log exists.
- [ ] Close the main window and use the tray Open action to recreate at most one window. Confirm the sidecar remains alive and its PID is stable across WebView recreation.
- [ ] Use explicit tray Quit and verify the child exits within the configured grace period. Also test host termination/EOF cleanup.
- [ ] `npm run build:tauri` creates the expected unsigned development artifact for the current platform. Record artifact path; signing/notarization remains out of scope.
- [ ] Inspect packaged contents: sidecar runtime/resources are present, generated build artifacts are not in Git, CSP/capabilities remain restrictive, and app data/credential namespace is separate from Electron.
- [ ] Benchmark full process tree with UI open/closed and local model loaded/unloaded before making resource-use claims.

The repository baseline currently has unrelated failures documented in `tauri-hybrid-ui-execution-plan.md` (including missing `AntigravityAuthService`). Report them separately rather than attributing them to the pilot.
