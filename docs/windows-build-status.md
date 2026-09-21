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

The latest Windows packaging workflow completed successfully on GitHub Actions run [35546650941](https://github.com/meharajM/WA-copilot/actions/runs/35546650941) for source commit `3d2b5980`. It prepared the target migration/keyring sidecars, passed the migration-reader reparse and Windows Credential Manager runtime round-trip smokes, verified staged resources and the NSIS/MSI bundle, passed the install/health/uninstall smoke, and uploaded the commit-specific unsigned artifacts. The companion plus `agentd` measured 75 MB peak resident memory and 0% average idle CPU against the 512 MB / 50% limits; reinstall smoke emitted `reinstallDataPreserved: true`. The exact outputs from that run are now committed as the public downloads below: browser ZIP `debe49296631880addf649c5e3cb050b7a416233b0fb5752ecc5248947e75f67`; NSIS `f7b996e495b11e0fa15406d077c48c87164e4953eeb22cec9e0117222a9a9a42`; MSI `d378a3509f3c73a548e569185516004d7884ef2db961a8cdb30471db43b30dc3`.

The current branch head `a1d42686` supersedes that historical evidence: package run [35638480307](https://github.com/meharajM/WA-copilot/actions/runs/35638480307) and full Windows run [35638480401](https://github.com/meharajM/WA-copilot/actions/runs/35638480401) passed the same migration-reader, Credential Manager, staged-resource, native-host, bundle, installer, resource-guard and unsigned NSIS install/health/uninstall gates. The public downloads below remain the earlier committed unsigned artifacts until a release-signing/publication step replaces them.

The full PR gate [35546652858](https://github.com/meharajM/WA-copilot/actions/runs/35546652858) also passed browser/agentd checks (43 test files, 338 tests), 11 native Rust tests, staged resource verification, Windows installer verification, and the same install/health/uninstall smoke. Its signed-input build is intentionally not substituted for the package artifact linked above because Windows bundle output is not byte-for-byte reproducible between runs. Signing, upgrade/downgrade, and real-profile continuity remain release gates.

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
