# Windows build status

Date: 2026-09-20

## Verified locally

- `npm run build:tauri:web` passed.
- `npm run build:tauri:win` reached the frontend build, then stopped before packaging.

## Why no Windows installer is attached

This build ran on macOS arm64. The repository intentionally rejects cross-target preparation for the Windows Credential Manager helper and migration-reader sidecars:

```text
Cross-target keyring-helper preparation is unsupported: target x86_64-pc-windows-msvc does not match host aarch64-apple-darwin
```

The repository does not claim an `.exe`, `.msi`, or signed Windows artifact until a Windows runner builds and signs those native sidecars. Publishing a macOS binary renamed as Windows would be invalid.

## Windows runner command

On Windows 10/11 with Node 22+, Rust, WebView2, and the Windows SDK installed:

```powershell
npm ci
npm run build:tauri:win
```

Expected outputs are under `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`. Upload the signed NSIS installer and portable artifact alongside this guide.

The public repository also includes a manual **Tauri Windows package** workflow. It performs the browser/native resource preparation, installer build, and artifact verification without replacing the full PR test gate. Dispatch it from the Actions tab on the branch you want to package; the uploaded artifact is named `aica-tauri-windows-package-<commit-sha>`. Artifacts are unsigned until they are processed by the release-signing step.
