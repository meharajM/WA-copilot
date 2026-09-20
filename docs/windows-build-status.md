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

The latest Windows packaging workflow completed successfully on GitHub Actions run [35544173834](https://github.com/meharajM/WA-copilot/actions/runs/35544173834) for source commit `74b0b605`. It prepared the target migration/keyring sidecars, passed the migration-reader reparse and Windows Credential Manager runtime round-trip smokes, verified staged resources and the NSIS/MSI bundle, and passed the install/health/uninstall smoke. The companion plus `agentd` measured 75 MB peak resident memory and 0% average idle CPU against the 512 MB / 50% limits. The same smoke also performed a scoped same-build NSIS repair/reinstall and emitted `reinstallDataPreserved: true` after verifying that a sentinel under the per-user data root survived; this is data-preservation evidence, not a signed version-to-version upgrade claim. The full Windows PR gate also passed on [35544173841](https://github.com/meharajM/WA-copilot/actions/runs/35544173841), including 11 native Rust tests, browser/agentd checks, and the same resource-guarded installer smoke. These are unsigned artifacts for the current migration implementation:

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
loopback `agentd` `/healthz` endpoint, samples the complete idle companion + agentd
resident set and CPU footprint for five seconds, enforces conservative 512 MB / 50%
guards, stops the disposable processes, performs a same-build repair/reinstall and
checks that a scoped per-user data sentinel survives, then silently uninstalls the
package. This closes unsigned install/health/uninstall and reinstall-preservation
behavior; certificate signing, version-to-version upgrade/downgrade and real-user
profile rollback remain release gates.
