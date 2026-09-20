# Windows build status

Date: 2026-09-21

## Verified locally

- `npm run build:tauri:web` passed.
- `npm run build:tauri:win` reached the frontend build, then stopped before packaging.
- The Windows package workflow passed both the Credential Manager round-trip smoke and migration-reader final-file/parent-junction reparse smoke.

## Windows runner result

This build ran on macOS arm64. The repository intentionally rejects cross-target preparation for the Windows Credential Manager helper and migration-reader sidecars:

```text
Cross-target keyring-helper preparation is unsupported: target x86_64-pc-windows-msvc does not match host aarch64-apple-darwin
```

The Windows packaging workflow completed successfully on GitHub Actions run [35539506483](https://github.com/meharajM/WA-copilot/actions/runs/35539506483) for source commit `ddcdf563`. The full Windows PR gate also passed on run [35539506534](https://github.com/meharajM/WA-copilot/actions/runs/35539506534), including native Rust host tests and the Task Scheduler round-trip. It prepared the target migration/keyring sidecars, passed the migration-reader reparse and Windows Credential Manager runtime round-trip smokes, and produced and verified these unsigned artifacts for the current migration implementation:

- [`AICA Native Host_1.0.0_x64-setup.exe`](downloads/AICA%20Native%20Host_1.0.0_x64-setup.exe)
- [`AICA Native Host_1.0.0_x64_en-US.msi`](downloads/AICA%20Native%20Host_1.0.0_x64_en-US.msi)

The files are attached in this public branch and their SHA-256 values are recorded in [`SHA256SUMS.txt`](downloads/SHA256SUMS.txt). They are unsigned build outputs; release signing and publication policy still need to run before general distribution.

## Windows runner command

On Windows 10/11 with Node 22+, Rust, WebView2, and the Windows SDK installed:

```powershell
npm ci
npm run build:tauri:win
```

Expected outputs are under `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`. Upload the signed NSIS installer and portable artifact alongside this guide.

The public repository also includes a manual **Tauri Windows package** workflow. It performs the browser/native resource preparation, installer build, and artifact verification without replacing the full PR test gate. Dispatch it from the Actions tab on the branch you want to package; the uploaded artifact is named `aica-tauri-windows-package-<commit-sha>`. Artifacts are unsigned until they are processed by the release-signing step.

The Windows workflows also run `scripts/windows-install-smoke.ps1` against the
generated NSIS installer. The smoke installs into an isolated runner directory,
launches the native companion in background mode, checks the descriptor-advertised
loopback `agentd` `/healthz` endpoint, stops the disposable processes, and
silently uninstalls the package. This closes unsigned install/health/uninstall
behavior; certificate signing, upgrade/downgrade and real-user profile rollback
remain release gates.
