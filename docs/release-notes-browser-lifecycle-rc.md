# AICA browser-first lifecycle RC

This public candidate packages the browser-first native companion from the `codex/browser-imap-inbound-attachments` branch.

## Included

- Browser workspace opened by the app icon; the native diagnostics window stays hidden by default.
- Tray/menu-bar controls for starting, stopping, and keeping the background agent alive.
- Explicit **Quit** path that stops the managed supervisor before exit.
- Windows x64 NSIS and MSI packages with Windows migration-reader, Credential Manager, install, health, and uninstall smoke checks.
- macOS Apple Silicon DMG and application ZIP built locally and checksum-verified.
- Browser pairing, dashboard, and Settings tutorial with screenshots: [`docs/windows-macos-browser-setup.md`](../windows-macos-browser-setup.md).

## Candidate boundary

These artifacts are unsigned. The macOS bundle is ad-hoc/linker-signed and not notarized; Windows signing is not configured. Production auto-reply and full migration remain gated by provider validation, signing/notarization, upgrade/rollback, backup/restore, and real-user evidence. See [`docs/release-readiness.md`](release-readiness.md).

Use the candidate for controlled QA only. Verify `SHA256SUMS` before installing.

