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

The latest Windows packaging workflow completed successfully on GitHub Actions run [35545050688](https://github.com/meharajM/WA-copilot/actions/runs/35545050688) for source commit `efe379e3`; the full PR gate also passed on [35545050684](https://github.com/meharajM/WA-copilot/actions/runs/35545050684). The source change since the prior package evidence is documentation-only, but this rerun is the authoritative current-head validation. It prepared the target migration/keyring sidecars, passed the migration-reader reparse and Windows Credential Manager runtime round-trip smokes, verified staged resources and the NSIS/MSI bundle, and passed the install/health/uninstall smoke. The companion plus `agentd` measured 72 MB peak resident memory and 0% average idle CPU against the 512 MB / 50% limits. The same smoke also performed a scoped same-build NSIS repair/reinstall and emitted `reinstallDataPreserved: true` after verifying that a sentinel under the per-user data root survived; this is data-preservation evidence, not a signed version-to-version upgrade claim. The full gate included 11 native Rust tests, browser/agentd checks, and the same resource-guarded installer smoke. The current-run CI bundle hashes were NSIS `b4c902646472ec42b7010b7b4c4606189332ba7cadf31897f0f51e08988bb2ec` and MSI `1565b6cf451c7d80871c9eeada038388a30299a73568113ace26862eaffbff83`; the committed public downloads below are the previously attached unsigned artifacts and retain the hashes in `SHA256SUMS.txt`.

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
